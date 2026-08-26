import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { fileURLToPath } from "node:url"

interface ToolDescriptor {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
}

interface PiToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >
  isError?: boolean
}

export interface PiMcpOptions {
  url: string
  headers: Record<string, string>
}

function endpoint(base: string, path: string): string {
  const url = new URL(base.includes("://") ? base : `https://${base}`)
  url.pathname = path
  url.search = ""
  url.hash = ""
  return url.toString()
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!response.ok) throw new Error(`Sandbox returned ${response.status}: ${text || response.statusText}`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error("Sandbox returned invalid JSON")
  }
}

function isToolCatalog(value: unknown): value is ToolDescriptor[] {
  return Array.isArray(value) && value.every((tool) => {
    if (typeof tool !== "object" || tool === null) return false
    const item = tool as Record<string, unknown>
    return typeof item.name === "string" && typeof item.description === "string" &&
      typeof item.inputSchema === "object" && item.inputSchema !== null
  })
}

function isPiToolResult(value: unknown): value is PiToolResult {
  return typeof value === "object" && value !== null && Array.isArray((value as PiToolResult).content)
}

export function createPiMcpServer(options: PiMcpOptions, fetcher: typeof fetch = fetch): Server {
  const headers = { ...options.headers, "X-aws-proxy-port": options.headers["X-aws-proxy-port"] ?? "8080" }
  let catalog: Promise<ToolDescriptor[]> | undefined
  const getCatalog = () => catalog ??= fetcher(endpoint(options.url, "/v1/pi/tools"), { headers })
    .then(responseJson)
    .then((value) => {
      if (!isToolCatalog(value)) throw new Error("Sandbox returned an invalid tool catalog")
      return value
    })

  const server = new Server(
    { name: "oc-remote-tools", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await getCatalog() }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const response = await fetcher(endpoint(options.url, `/v1/pi/tools/${encodeURIComponent(request.params.name)}`), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(request.params.arguments ?? {}),
        signal: extra.signal,
      })
      const result = await responseJson(response)
      if (!isPiToolResult(result)) throw new Error("Sandbox returned an invalid tool result")
      return { content: result.content, ...(result.isError ? { isError: true } : {}) }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })
  return server
}

function argumentValues(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[++index]!)
    else if (args[index]?.startsWith(`${name}=`)) values.push(args[index]!.slice(name.length + 1))
  }
  return values
}

export function parseOptions(args = process.argv.slice(2), env = process.env): PiMcpOptions {
  const url = argumentValues(args, "--url").at(-1) ?? env.PI_SANDBOX_URL
  if (!url) throw new Error("Provide --url or PI_SANDBOX_URL")

  let headers: Record<string, string> = {}
  if (env.PI_SANDBOX_HEADERS) {
    const value = JSON.parse(env.PI_SANDBOX_HEADERS) as unknown
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !Object.values(value).every((item) => typeof item === "string")) {
      throw new Error("PI_SANDBOX_HEADERS must be a JSON object of string values")
    }
    headers = value as Record<string, string>
  }
  for (const header of argumentValues(args, "--header")) {
    const separator = header.indexOf(":")
    if (separator < 1) throw new Error(`Invalid --header value: ${header}`)
    headers[header.slice(0, separator).trim()] = header.slice(separator + 1).trim()
  }
  return { url, headers }
}

export async function main(): Promise<void> {
  const server = createPiMcpServer(parseOptions())
  await server.connect(new StdioServerTransport())
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
