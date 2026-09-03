import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { ProviderConfigurationId, ToolName } from "@waterbox/contracts"
import type { SandboxProvider } from "@waterbox/core/provider"
import {
  BoxSandboxProvider as InternalBoxSandboxProvider,
  deriveBoxProviderConfigurationId as deriveConfigurationId,
  loadSandboxRuntimeArtifact as loadArtifact,
} from "./index.ts"

const PACKAGE_VERSION = "0.1.0-alpha.1"

export interface BoxProviderClock {
  now(): Date
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
}

export interface BoxProviderConfig {
  apiBaseUrl: string
  apiKey: string
  polling: { intervalMs: number; timeoutMs: number }
  automaticStopMs?: number
}

export interface SandboxRuntimeArtifact {
  bytes: Uint8Array
  sha256: string
  cliProtocolVersion: 2
  artifactVersion: string
}

export type BoxProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export type BoxProviderDiagnostic =
  | { type: "tool-http-error"; status: number }
  | { type: "tool-command"; tool: ToolName; success: boolean; exitCode: number | null; timedOut: boolean; stdoutTruncated: boolean; stderrTruncated: boolean; hasStderr: boolean }
  | { type: "tool-event-invalid"; tool: ToolName }
  | { type: "preparation"; stage: "verify" | "final-verify"; outcome: "complete" | "incomplete" | "ambiguous" | "failure" }
  | { type: "preparation"; stage: "upload" | "install"; outcome: "complete" | "ambiguous" | "failure" }

export interface BoxProviderDependencies {
  artifact?: SandboxRuntimeArtifact
  clock?: BoxProviderClock
  fetch?: BoxProviderFetch
  diagnostic?: (event: BoxProviderDiagnostic) => void
}

export class SystemBoxProviderClock implements BoxProviderClock {
  now(): Date { return new Date() }
  sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const timer = setTimeout(done, milliseconds)
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")) }
      function done() { signal.removeEventListener("abort", abort); resolve() }
      signal.addEventListener("abort", abort, { once: true })
    })
  }
}

/** A Box provider composed with the CLI artifact shipped in this package. */
export class BoxSandboxProvider implements SandboxProvider {
  readonly #provider: SandboxProvider
  readonly name: string
  readonly stopResume: SandboxProvider["stopResume"]
  readonly snapshots: SandboxProvider["snapshots"]
  readonly secureFileTransfer: NonNullable<SandboxProvider["secureFileTransfer"]>
  readonly bashJobs: NonNullable<SandboxProvider["bashJobs"]>

  constructor(config: BoxProviderConfig, dependencies: BoxProviderDependencies = {}) {
    const provider = new InternalBoxSandboxProvider(config, {
      artifact: dependencies.artifact ?? bundledSandboxRuntimeArtifact(),
      clock: dependencies.clock ?? new SystemBoxProviderClock(),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.diagnostic === undefined ? {} : { diagnostic: dependencies.diagnostic }),
    })
    this.#provider = provider
    this.name = provider.name
    this.stopResume = provider.stopResume
    this.snapshots = provider.snapshots
    this.secureFileTransfer = provider.secureFileTransfer!
    this.bashJobs = provider.bashJobs!
  }

  createSandbox: SandboxProvider["createSandbox"] = input => this.#provider.createSandbox(input)
  prepareSandbox: SandboxProvider["prepareSandbox"] = input => this.#provider.prepareSandbox(input)
  inspectSandbox: SandboxProvider["inspectSandbox"] = input => this.#provider.inspectSandbox(input)
  deleteSandbox: SandboxProvider["deleteSandbox"] = input => this.#provider.deleteSandbox(input)
  executeTool: SandboxProvider["executeTool"] = input => this.#provider.executeTool(input)
}

export function createBoxSandboxProvider(config: BoxProviderConfig, dependencies: BoxProviderDependencies = {}): BoxSandboxProvider {
  return new BoxSandboxProvider(config, dependencies)
}

export function deriveBoxProviderConfigurationId(config: BoxProviderConfig): ProviderConfigurationId {
  return deriveConfigurationId(config)
}

export function loadSandboxRuntimeArtifact(location: URL, artifactVersion: string): Promise<SandboxRuntimeArtifact> {
  return loadArtifact(location, artifactVersion)
}

function bundledSandboxRuntimeArtifact(): SandboxRuntimeArtifact {
  let bytes: Uint8Array
  try { bytes = readFileSync(new URL("./waterbox-cli.js", import.meta.url)) }
  catch { throw new TypeError("Bundled Box sandbox runtime artifact could not be loaded") }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    cliProtocolVersion: 2,
    artifactVersion: PACKAGE_VERSION,
  }
}
