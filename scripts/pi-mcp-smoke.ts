import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms"
import { fromIni } from "@aws-sdk/credential-providers"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

interface Deployment {
  profile: string
  region: string
  imageIdentifier: string
  imageVersion: string
}

interface Attachment {
  endpoint: string
  headers: Record<string, string>
}

const root = resolve(import.meta.dir, "..")
const deploymentPath = resolve(root, ".oc-remote/deployment.json")
const mcpEntry = resolve(root, "packages/pi-mcp/src/server.ts")
const nativeTools = ["shell", "read", "write", "edit", "patch", "glob", "grep", "subagent"]

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`AWS did not return ${label}`)
  return value
}

async function request(attachment: Attachment, path: string, body?: unknown): Promise<unknown> {
  const url = new URL(attachment.endpoint.includes("://") ? attachment.endpoint : `https://${attachment.endpoint}`)
  url.pathname = path
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...attachment.headers,
      "X-aws-proxy-port": "8080",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`)
  return text ? JSON.parse(text) as unknown : undefined
}

function toolNames(output: string): string[] {
  const names: string[] = []
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: string; part?: { tool?: string } }
      if (event.type === "tool_use" && event.part?.tool) names.push(event.part.tool)
    } catch {
      // OpenCode diagnostics may be interleaved with its JSON event stream.
    }
  }
  return names
}

function runOpenCode(
  directory: string,
  attachment: Attachment,
  permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" }>,
  prompt: string,
): { output: string; tools: string[] } {
  const config = {
    model: "openai/gpt-5.6-sol",
    permissions,
    mcp: {
      servers: {
        workspace: {
          type: "local",
          command: ["bun", "run", mcpEntry],
          environment: {
            PI_SANDBOX_URL: attachment.endpoint,
            PI_SANDBOX_HEADERS: JSON.stringify(attachment.headers),
          },
          codemode: false,
          timeout: { startup: 30_000, catalog: 30_000, execution: 300_000 },
        },
      },
    },
  }
  const configPath = join(directory, `.opencode-${crypto.randomUUID()}.json`)
  writeFileSync(configPath, JSON.stringify(config))
  try {
    const result = spawnSync(
      "opencode2",
      ["run", "--standalone", "--auto", "--format", "json", "--model", "openai/gpt-5.6-sol", prompt],
      {
        cwd: directory,
        env: {
          ...process.env,
          PWD: directory,
          OPENCODE_CONFIG: configPath,
          OPENCODE_CONFIG_PROJECT_DISABLE: "true",
        },
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
    )
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`OpenCode exited ${result.status}: ${result.stderr || result.stdout}`)
    process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    return { output: result.stdout, tools: toolNames(result.stdout) }
  } finally {
    rmSync(configPath, { force: true })
  }
}

async function waitForAttachment(
  client: LambdaMicrovmsClient,
  id: string,
  initialEndpoint: string | undefined,
): Promise<Attachment> {
  let endpoint = initialEndpoint
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    const current = await client.send(new GetMicrovmCommand({ microvmIdentifier: id }))
    endpoint = current.endpoint ?? endpoint
    if (current.state === "RUNNING" && endpoint) break
    if (current.state === "TERMINATED" || current.state === "TERMINATING") {
      throw new Error(`MicroVM terminated while starting: ${current.stateReason ?? current.state}`)
    }
    await Bun.sleep(2_000)
  }
  if (!endpoint) throw new Error("MicroVM did not provide an endpoint")
  const token = await client.send(new CreateMicrovmAuthTokenCommand({
    microvmIdentifier: id,
    expirationInMinutes: 30,
    allowedPorts: [{ port: 8080 }],
  }))
  const headers = token.authToken
  if (!headers || Object.keys(headers).length === 0) throw new Error("AWS did not return a port auth token")
  const attachment = { endpoint, headers: headers as Record<string, string> }
  const healthDeadline = Date.now() + 5 * 60_000
  while (Date.now() < healthDeadline) {
    try {
      await request(attachment, "/health")
      return attachment
    } catch {
      await Bun.sleep(2_000)
    }
  }
  throw new Error("Receiver did not become healthy")
}

async function main(): Promise<void> {
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as Deployment
  const client = new LambdaMicrovmsClient({
    region: deployment.region,
    credentials: fromIni({ profile: deployment.profile }),
  })
  const directory = await mkdtemp(join(tmpdir(), "remote-tools-smoke-"))
  const marker = `remote-smoke-${crypto.randomUUID()}`
  let id: string | undefined
  try {
    const run = await client.send(new RunMicrovmCommand({
      imageIdentifier: deployment.imageIdentifier,
      imageVersion: deployment.imageVersion,
      maximumDurationInSeconds: 1_800,
      ingressNetworkConnectors: [
        `arn:aws:lambda:${deployment.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
      ],
      egressNetworkConnectors: [
        `arn:aws:lambda:${deployment.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
      ],
    }))
    id = required(run.microvmId, "the MicroVM ID")
    const attachment = await waitForAttachment(client, id, run.endpoint)

    const forced = runOpenCode(
      directory,
      attachment,
      [
        ...nativeTools.map((action) => ({ action, resource: "*", effect: "deny" as const })),
        { action: "workspace_*", resource: "*", effect: "allow" },
      ],
      `A remote environment is accessible through the workspace_* tools. Use each available workspace_* tool at least once there: bash only to create /workspace/remote-smoke, write to create state.txt containing exactly "${marker}\\nstatus: forced\\n", read it, ls its directory, find it by glob, grep for the marker, edit status to "ready", then read it again. Execute these operations; do not merely describe commands.`,
    )
    const coexist = runOpenCode(
      directory,
      attachment,
      [
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "workspace_*", resource: "*", effect: "allow" },
      ],
      "A remote environment is accessible through the workspace_* tools; native tools access the local environment. Use the workspace_* tools to inspect /workspace/remote-smoke/state.txt left by a prior task, change `status: ready` to `status: coexist`, and verify it. Do not alter the local environment.",
    )

    const verification = await request(attachment, "/v1/pi/tools/read", { path: "/workspace/remote-smoke/state.txt" }) as {
      content?: Array<{ type?: string; text?: string }>
    }
    const text = verification.content?.find((part) => part.type === "text")?.text
    const expectedForced = `${marker}\nstatus: ready\n`
    const expectedCoexist = `${marker}\nstatus: coexist\n`
    if (text !== expectedForced && text !== expectedCoexist) {
      throw new Error(`Unexpected final remote state: ${JSON.stringify(text)}`)
    }
    const requiredForcedTools = ["bash", "write", "read", "ls", "find", "grep", "edit"]
    const missing = requiredForcedTools.filter((name) => !forced.tools.includes(`workspace_${name}`))
    if (missing.length > 0) throw new Error(`Forced run did not exercise workspace tools: ${missing.join(", ")}`)
    const localEntries = await readdir(directory)
    if (localEntries.length !== 0) throw new Error(`Smoke modified local workspace: ${localEntries.join(", ")}`)
    console.log(JSON.stringify({
      type: "summary",
      microvmID: id,
      forcedTools: forced.tools,
      coexistTools: coexist.tools,
      coexistWorkspaceAvailable: coexist.tools.some((name) => name.startsWith("workspace_")),
      finalStatus: text === expectedCoexist ? "coexist" : "ready",
    }))
  } finally {
    await rm(directory, { recursive: true, force: true })
    if (id) {
      await client.send(new TerminateMicrovmCommand({ microvmIdentifier: id })).catch((error) => {
        console.error(`Failed to terminate ${id}:`, error)
      })
      console.log(`Terminated ${id}`)
    }
  }
}

await main()
