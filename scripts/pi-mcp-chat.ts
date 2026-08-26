import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms"
import { fromIni } from "@aws-sdk/credential-providers"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { constants } from "node:fs"
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"

interface Deployment {
  profile: string
  region: string
  imageIdentifier: string
  imageVersion: string
}

const root = resolve(import.meta.dir, "..")
const deploymentPath = resolve(root, ".oc-remote/deployment.json")
const mcpEntry = resolve(root, "packages/pi-mcp/src/server.ts")
const forceRemote = process.argv.includes("--force-remote")

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`AWS did not return ${label}`)
  return value
}

async function executable(path: string): Promise<string | undefined> {
  return access(path, constants.X_OK).then(() => path, () => undefined)
}

async function resolveOpenCode(): Promise<string> {
  if (process.env.OPENCODE2_BIN) {
    const configured = await executable(resolve(process.env.OPENCODE2_BIN))
    if (configured) return configured
    throw new Error(`OPENCODE2_BIN is not executable: ${process.env.OPENCODE2_BIN}`)
  }
  const local = await executable(join(root, "node_modules/.bin/opencode2"))
  if (local) return local
  const pathCandidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "opencode2"))
  if (process.env.NVM_BIN) pathCandidates.push(join(process.env.NVM_BIN, "opencode2"))
  for (const candidate of pathCandidates) {
    const found = await executable(candidate)
    if (found) return found
  }
  const versionsRoot = join(homedir(), ".nvm/versions/node")
  const versions = await readdir(versionsRoot).catch(() => [])
  for (const version of [...versions].sort().reverse()) {
    const found = await executable(join(versionsRoot, version, "bin/opencode2"))
    if (found) return found
  }
  throw new Error("opencode2 was not found; install @opencode-ai/cli or set OPENCODE2_BIN")
}

async function health(endpoint: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const url = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`)
    url.pathname = "/health"
    const response = await fetch(url, { headers: { ...headers, "X-aws-proxy-port": "8080" } })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const openCode = await resolveOpenCode()
  const deployment = JSON.parse(await readFile(deploymentPath, "utf8")) as Deployment
  const client = new LambdaMicrovmsClient({
    region: deployment.region,
    credentials: fromIni({ profile: deployment.profile }),
  })
  const directory = await mkdtemp(join(tmpdir(), "remote-tools-chat-"))
  const configPath = join(directory, "opencode.json")
  let id: string | undefined

  try {
    const run = await client.send(new RunMicrovmCommand({
      imageIdentifier: deployment.imageIdentifier,
      imageVersion: deployment.imageVersion,
      maximumDurationInSeconds: 3_600,
      ingressNetworkConnectors: [
        `arn:aws:lambda:${deployment.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
      ],
      egressNetworkConnectors: [
        `arn:aws:lambda:${deployment.region}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
      ],
    }))
    id = required(run.microvmId, "the MicroVM ID")
    let endpoint = run.endpoint
    const runningDeadline = Date.now() + 5 * 60_000
    while (Date.now() < runningDeadline) {
      const current = await client.send(new GetMicrovmCommand({ microvmIdentifier: id }))
      endpoint = current.endpoint ?? endpoint
      if (current.state === "RUNNING" && endpoint) break
      if (current.state === "TERMINATED" || current.state === "TERMINATING") {
        throw new Error(`MicroVM terminated while starting: ${current.stateReason ?? current.state}`)
      }
      await Bun.sleep(2_000)
    }
    endpoint = required(endpoint, "the MicroVM endpoint")

    const token = await client.send(new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: id,
      expirationInMinutes: 60,
      allowedPorts: [{ port: 8080 }],
    }))
    const headers = token.authToken
    if (!headers || Object.keys(headers).length === 0) throw new Error("AWS did not return a port auth token")
    const authHeaders = headers as Record<string, string>
    const healthDeadline = Date.now() + 5 * 60_000
    while (!(await health(endpoint, authHeaders))) {
      if (Date.now() >= healthDeadline) throw new Error("Receiver did not become healthy")
      await Bun.sleep(2_000)
    }

    const permissions = [
      ...(forceRemote
        ? ["shell", "read", "write", "edit", "patch", "glob", "grep"].map((action) => ({
            action,
            resource: "*",
            effect: "deny",
          }))
        : []),
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "workspace_*", resource: "*", effect: "allow" },
    ]
    await writeFile(configPath, JSON.stringify({
      permissions,
      mcp: {
        servers: {
          workspace: {
            type: "local",
            command: ["bun", "run", mcpEntry],
            environment: {
              PI_SANDBOX_URL: endpoint,
              PI_SANDBOX_HEADERS: JSON.stringify(authHeaders),
            },
            codemode: false,
            timeout: { startup: 30_000, catalog: 30_000, execution: 300_000 },
          },
        },
      },
    }))

    console.log(`MicroVM: ${id}`)
    console.log(`Mode: ${forceRemote ? "native tools denied" : "native and workspace tools enabled"}`)
    console.log("Tell the model: A remote environment is accessible through the workspace_* tools.")
    console.log("The VM will be terminated when OpenCode exits.\n")

    const child = spawn(openCode, ["--standalone", "--auto"], {
      cwd: directory,
      env: {
        ...process.env,
        PWD: directory,
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_PROJECT_DISABLE: "true",
      },
      stdio: "inherit",
    })
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null]
    if (code !== 0 && signal === null) throw new Error(`OpenCode exited with status ${code}`)
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
