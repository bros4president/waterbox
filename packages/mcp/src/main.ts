#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { SandboxId, ToolName } from "@waterbox/contracts"
import type { ToolArgumentsByName, ToolEventByName } from "@waterbox/core/provider"
import { fileURLToPath } from "node:url"
import type { McpBackend } from "./backend.ts"
import { MissingMcpCredentialError, parseMcpConfig } from "./config.ts"
import { createMcpBackend } from "./direct.ts"
import { createWaterboxMcpServer } from "./server.ts"

export async function main(): Promise<void> {
  const backend = await createStartupBackend()
  const server = createWaterboxMcpServer(backend, process.env.WATERBOX_MCP_DIAGNOSTICS === "1"
    ? { onError: (error) => console.error(diagnosticMessage(error)) }
    : {})
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await server.close() } finally { await backend.close() }
  }
  server.onclose = () => { void backend.close() }
  process.once("SIGINT", () => { void close() })
  process.once("SIGTERM", () => { void close() })
  try {
    await server.connect(new StdioServerTransport())
  } catch (error) {
    await backend.close()
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

export async function createStartupBackend(environment: Record<string, string | undefined> = process.env): Promise<McpBackend> {
  try {
    return await createMcpBackend(parseMcpConfig(environment))
  } catch (error) {
    if (!(error instanceof MissingMcpCredentialError)) throw error
    return {
      async createSandbox() { throw error },
      async probeSandbox() { throw error },
      async deleteSandbox() { throw error },
      async listSnapshots() { throw error },
      async createSnapshot() { throw error },
      async deleteSnapshot() { throw error },
      async initiateSecureFileTransfer() { throw error },
      async consumeSecureFileTransfer() { throw error },
      async executeTool<N extends ToolName>(
        _sandboxId: SandboxId,
        _toolName: N,
        _arguments: ToolArgumentsByName[N],
        _signal: AbortSignal,
      ): Promise<AsyncIterable<ToolEventByName[N]>> { throw error },
      async close() {},
    }
  }
}

function startupMessage(error: unknown): string {
  if (error instanceof Error && ["McpConfigurationError", "UnsupportedMcpProviderError"].includes(error.name)) return error.message
  return "Waterbox MCP failed to start"
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(startupMessage(error)); process.exitCode = 1 })
}
