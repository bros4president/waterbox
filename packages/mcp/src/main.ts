import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createRemoteApiBackend, WaterboxClient } from "@waterbox/client"
import { McpConfigurationError, parseMcpConfig } from "./config.ts"
import { createMcpClient, type LocalProviderDiagnostic } from "./composition.ts"
import { createWaterboxMcpServer } from "./server.ts"

export async function main(): Promise<void> {
  const diagnostics = process.env.WATERBOX_MCP_DIAGNOSTICS === "1"
  const client = await createStartupClient(process.env, diagnostics ? event => console.error(boxDiagnosticMessage(event)) : undefined)
  const server = createWaterboxMcpServer(client, diagnostics
    ? { onError: (error) => console.error(diagnosticMessage(error)) }
    : {})
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await server.close() } finally { await client.close() }
  }
  server.onclose = () => { void client.close() }
  process.once("SIGINT", () => { void close() })
  process.once("SIGTERM", () => { void close() })
  try {
    await server.connect(new StdioServerTransport())
  } catch (error) {
    await client.close()
    throw error
  }
}

function diagnosticMessage(error: unknown): string {
  const messages: string[] = []
  let current = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const code = "code" in current && typeof current.code === "string" ? `:${current.code}` : ""
    const kind = "kind" in current && typeof current.kind === "string" ? `:${current.kind}` : ""
    const safe = ["DomainError", "McpConfigurationError", "MissingMcpCredentialError", "ProviderError"].includes(current.name)
    messages.push(`${current.name}${code}${kind}${safe ? `: ${current.message}` : ""}`)
    current = current.cause
  }
  return `Waterbox MCP diagnostic: ${messages.join(" <- ")}`
}

export async function createStartupClient(environment: Record<string, string | undefined> = process.env, diagnostic?: (event: LocalProviderDiagnostic) => void): Promise<WaterboxClient> {
  try {
    return await createMcpClient(parseMcpConfig(environment), diagnostic)
  } catch (error) {
    if (!(error instanceof McpConfigurationError) && !(error instanceof Error && error.name === "UnsupportedMcpProviderError")) throw error
    return unavailableClient(error)
  }
}

function boxDiagnosticMessage(event: LocalProviderDiagnostic): string { return `Waterbox MCP diagnostic: ${JSON.stringify(event)}` }

function unavailableClient(error: Error): WaterboxClient {
  const client = new WaterboxClient(createRemoteApiBackend("http://waterbox.unconfigured/", async () => { throw error }))
  return Object.assign(client, { preflight() { throw error } })
}

export function startupMessage(error: unknown): string {
  if (error instanceof Error && ["McpConfigurationError", "UnsupportedMcpProviderError"].includes(error.name)) return error.message
  return "Waterbox MCP failed to start"
}
