import {
  assertCommandInput,
  assertCommandResult,
  assertCreateInput,
  assertWriteFileInput,
  type InfrastructureCommandInput,
  type InfrastructureCommandResult,
  type InfrastructureCreateInput,
  type InfrastructureCreateSnapshotInput,
  type InfrastructureInventoryInput,
  type InfrastructureSandboxInput,
  type InfrastructureSandboxObservation,
  type InfrastructureSnapshotInput,
  type InfrastructureSnapshotObservation,
  type InfrastructureWriteFileInput,
  type JsonValue,
  type JsonReference,
  type SandboxInfrastructure,
} from "./index.ts"

export class PrimitiveError extends Error {}

type SandboxEntry = { state: InfrastructureSandboxObservation["state"]; ref: JsonReference }

/** Provider-neutral fake used by shared runtime conformance before a real adapter is migrated. */
export class FakeSandboxInfrastructure implements SandboxInfrastructure {
  readonly name = "fake-infrastructure"
  readonly sandboxes = new Map<string, SandboxEntry>()
  readonly files = new Map<string, { contents: Uint8Array; mode?: number }>()
  readonly commands: InfrastructureCommandInput[] = []
  readonly writes: InfrastructureWriteFileInput[] = []
  readonly createInputs: InfrastructureCreateInput[] = []
  commandHandler?: (input: InfrastructureCommandInput) => InfrastructureCommandResult | Promise<InfrastructureCommandResult>
  writeHandler?: (input: InfrastructureWriteFileInput) => void | Promise<void>
  snapshotCreateCalls = 0
  beforeSnapshotDispatch?: () => void
  snapshotSourceObservation?: InfrastructureSandboxObservation
  readonly stopResume = {
    stop: async (input: InfrastructureSandboxInput) => this.setState(input, "stopped"),
    resume: async (input: InfrastructureSandboxInput) => this.setState(input, "running"),
  }
  readonly snapshots = {
    create: async (input: InfrastructureCreateSnapshotInput): Promise<InfrastructureSnapshotObservation> => {
      const source = this.entry(input.providerRef)
      // Native revalidation belongs immediately next to snapshot dispatch.
      this.snapshotCreateCalls++
      this.beforeSnapshotDispatch?.()
      if (source.state !== "running") throw new PrimitiveError("Snapshot source is not running")
      const providerRef: JsonReference = { fakeSnapshot: input.snapshotId }
      this.#snapshotEntries.set(input.snapshotId, { state: "ready", ref: providerRef })
      return { state: "ready", providerRef, ...(this.snapshotSourceObservation === undefined ? {} : { sourceSandbox: this.snapshotSourceObservation }) }
    },
    inspect: async (input: InfrastructureSnapshotInput) => this.snapshot(input),
    delete: async (input: InfrastructureSnapshotInput) => {
      const entry = this.#snapshotEntries.get(input.snapshotId)
      if (entry !== undefined) entry.state = "deleted"
      return { state: "deleted" as const, providerRef: input.providerRef }
    },
  }
  readonly inventory: NonNullable<SandboxInfrastructure["inventory"]> = {
    listSandboxes: async function* (this: FakeSandboxInfrastructure, _input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSandboxObservation> {
      yield* [...this.sandboxes.values()].map((entry) => ({ state: entry.state, providerRef: entry.ref }))
    }.bind(this),
    listSnapshots: async function* (this: FakeSandboxInfrastructure, _input: InfrastructureInventoryInput): AsyncIterable<InfrastructureSnapshotObservation> {
      yield* [...this.#snapshotEntries.values()].map((entry) => ({ state: entry.state, providerRef: entry.ref }))
    }.bind(this),
  }
  readonly #snapshotEntries = new Map<string, { state: InfrastructureSnapshotObservation["state"]; ref: JsonReference }>()

  async create(input: InfrastructureCreateInput): Promise<InfrastructureSandboxObservation> {
    assertCreateInput(input)
    this.createInputs.push(input)
    const providerRef: JsonReference = { fakeSandbox: input.sandboxId }
    this.sandboxes.set(input.sandboxId, { state: "running", ref: providerRef })
    return { state: "running", providerRef }
  }

  async inspect(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    const entry = this.entry(input.providerRef)
    return { state: entry.state, providerRef: entry.ref }
  }

  async runCommand(input: InfrastructureCommandInput): Promise<InfrastructureCommandResult> {
    assertCommandInput(input)
    this.entry(input.providerRef)
    this.commands.push(input)
    const result = await (this.commandHandler?.(input) ?? { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), timedOut: false, stdoutTruncated: false, stderrTruncated: false })
    assertCommandResult(result, input)
    return result
  }

  async writeFile(input: InfrastructureWriteFileInput): Promise<void> {
    assertWriteFileInput(input)
    this.entry(input.providerRef)
    this.writes.push(input)
    this.files.set(input.path, { contents: input.contents.slice(), ...(input.mode === undefined ? {} : { mode: input.mode }) })
    await this.writeHandler?.(input)
  }

  async delete(input: InfrastructureSandboxInput): Promise<InfrastructureSandboxObservation> {
    return this.setState(input, "terminated")
  }

  private async setState(input: InfrastructureSandboxInput, state: InfrastructureSandboxObservation["state"]): Promise<InfrastructureSandboxObservation> {
    const entry = this.entry(input.providerRef)
    entry.state = state
    return { state, providerRef: entry.ref }
  }

  private async snapshot(input: InfrastructureSnapshotInput): Promise<InfrastructureSnapshotObservation> {
    const entry = this.#snapshotEntries.get(input.snapshotId)
    return { state: entry?.state ?? "deleted", providerRef: entry?.ref ?? input.providerRef }
  }

  private entry(providerRef: JsonReference): SandboxEntry {
    if (isJsonRecord(providerRef) && typeof providerRef.fakeSandbox === "string") {
      const entry = this.sandboxes.get(providerRef.fakeSandbox)
      if (entry !== undefined) return entry
    }
    throw new PrimitiveError("Unknown fake sandbox")
  }
}

function isJsonRecord(value: JsonReference): value is { readonly [key: string]: JsonReference } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
