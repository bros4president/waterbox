import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { atomicMetadataWrite, buildBoxTemplate, buildFingerprint, createBuildRequests, healthCommand, HttpBoxTemplateTransport, installCommand, loadBuilderConfig, parseTemplateMetadata, redactSecrets, snapshotBuildName, systemdUnit, type BoxTemplateTransport, type BuilderConfig, type OwnedBox, type OwnedSnapshot, type TemplateMetadata } from "./box-template-builder.ts"

const config: BuilderConfig = { apiBaseUrl: "https://api.box.test", apiKey: "box-secret-key", templateName: "waterbox-system-v1", daemonPort: 8080, metadataPath: "/tmp/metadata.json", artifactPath: "/tmp/waterbox-daemon", dryRun: false, pollIntervalMs: 1, pollTimeoutMs: 100, requestTimeoutMs: 50 }
const testRoot = await mkdtemp(join(tmpdir(), "waterbox-builder-tests-")); let testPath = 0
const isolated = (overrides: Partial<BuilderConfig> = {}): BuilderConfig => ({ ...config, metadataPath: join(testRoot, `metadata-${testPath++}.json`), artifactPath: join(testRoot, `artifact-${testPath}.bin`), ...overrides })
afterAll(async () => { await rm(testRoot, { recursive: true, force: true }) })
const sourceKey = `waterbox-template-${"a".repeat(64)}`

describe("Box template request and command construction", () => {
  test("creates a stable no-env, idempotent build sequence without credentials", () => {
    const first = createBuildRequests(config, new Uint8Array([1, 2, 3]))
    expect(first).toEqual(createBuildRequests(config, new Uint8Array([1, 2, 3])))
    expect(first[0]).toEqual({ method: "POST", path: "/boxes", headers: { "idempotency-key": `waterbox-template-${buildFingerprint(config, new Uint8Array([1, 2, 3]))}` }, json: { noEnv: true, env: { WATERBOX_BUILD_FINGERPRINT: buildFingerprint(config, new Uint8Array([1, 2, 3])) } } })
    expect(createBuildRequests({ ...config, daemonPort: 8081 }, new Uint8Array([1, 2, 3]))[0]).not.toEqual(first[0])
    expect(createBuildRequests({ ...config, templateName: "other" }, new Uint8Array([1, 2, 3]))[0]).not.toEqual(first[0])
    expect(JSON.stringify(first)).not.toContain(config.apiKey)
    expect(first.map((request) => request.path)).toEqual(["/boxes", "/boxes/{boxId}/files", "/boxes/{boxId}/files", "/boxes/{boxId}/commands", "/boxes/{boxId}/commands", "/boxes/{boxId}/stop", "/named-snapshots"])
  })
  test("installs runtime dependencies and a boot-enabled daemon service", () => {
    expect(installCommand()).toContain("ripgrep curl")
    expect(installCommand()).toContain("systemctl enable --now waterbox-daemon.service")
    expect(healthCommand(9123)).toContain("127.0.0.1:9123/health")
    expect(systemdUnit(9123)).toContain("Environment=WORKSPACE_ROOT=/workspace")
    expect(systemdUnit(9123)).toContain("Environment=PORT=9123")
    expect(systemdUnit(9123)).toContain("WantedBy=multi-user.target")
    expect(systemdUnit(9123)).not.toMatch(/BOX_API_KEY|Bearer|api\.box/)
  })
  test("validates dry-run configuration without requiring the API key", () => {
    expect(loadBuilderConfig({ BOX_API_BASE_URL: "https://api.box.test" }, ["--dry-run"]).dryRun).toBe(true)
    expect(() => loadBuilderConfig({}, [])).toThrow("BOX_API_KEY is required")
    expect(() => loadBuilderConfig({ BOX_API_KEY: "key", BOX_API_BASE_URL: "http://unsafe.test" }, [])).toThrow("HTTPS origin")
  })
})

describe("metadata and failure safety", () => {
  test("strictly parses secret-free deployment metadata", () => {
    const value = { version: 1, provider: "box", templateRef: "snapshot-1", templateName: "waterbox-system-v1", buildFingerprint: "b".repeat(64), artifactSha256: "a".repeat(64), snapshotArtifactId: "artifact-1", daemonPort: 8080, builtAt: "2026-08-26T00:00:00.000Z" } as const
    expect(parseTemplateMetadata(value)).toEqual(value)
    for (const invalid of [{ ...value, apiKey: "secret" }, { ...value, version: 2 }, { ...value, artifactSha256: "bad" }, { ...value, builtAt: "never" }]) expect(() => parseTemplateMetadata(invalid)).toThrow("metadata is invalid")
  })
  test("redacts API keys and protected URL query credentials", () => {
    const protectedUrl = "https://protected.box.test/access?signature=url-secret"
    const text = redactSecrets(new Error(`failed ${config.apiKey} ${protectedUrl}`), [config.apiKey, protectedUrl])
    expect(text).not.toContain(config.apiKey)
    expect(text).not.toContain("url-secret")
  })
  test("permanently deletes the temporary box after an installation failure", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input); requests.push({ url, init })
      if (url.endsWith("/boxes") && init?.method === "POST") return Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "ready" } }, { status: 202 })
      if (url.endsWith("/boxes/bx_23456789") && init?.method === "GET") return Response.json({ ok: true, type: "box.info", box: { id: "bx_23456789", state: "ready" } })
      if (init?.method === "PUT") { const body = JSON.parse(String(init.body)); return Response.json({ ok: true, type: "file.written", success: true, path: body.path, encoding: "base64", size: 1 }) }
      if (url.endsWith("/commands")) return Response.json({ ok: true, type: "command.finished", success: false, exitCode: 1, stdout: "", stderr: `bad ${config.apiKey}`, timedOut: false })
      if (url.endsWith("/boxes/bx_23456789") && init?.method === "DELETE") return Response.json({ ok: true, type: "box.deleting", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", status: "completed" } }, { status: 202 })
      if (url.includes("/deletion-operations/")) return Response.json({ ok: true, type: "deletion.operation", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", status: "completed" } })
      throw new Error(`unexpected ${init?.method} ${url}`)
    }
    await expect(buildBoxTemplate(isolated(), { fetch: fakeFetch, buildArtifact: async () => {}, readArtifact: async () => new Uint8Array([1]), log: () => {} })).rejects.toThrow("Box command failed")
    expect(requests.some(request => request.url === "https://api.box.test/boxes/bx_23456789" && request.init?.method === "DELETE")).toBe(true)
    expect(requests.at(-1)?.url).toContain("/deletion-operations/")
  })
  test("dry run builds and validates locally but sends no provider requests or metadata writes", async () => {
    let fetches = 0; let writes = 0; const logs: string[] = []
    await expect(buildBoxTemplate(isolated({ dryRun: true }), { fetch: async () => { fetches++; throw new Error("network forbidden") }, buildArtifact: async () => {}, readArtifact: async () => new Uint8Array([1, 2]), writeMetadata: async () => { writes++ }, log: (message) => logs.push(message) })).resolves.toBeUndefined()
    expect(fetches).toBe(0); expect(writes).toBe(0); expect(logs.at(-1)).toContain("no Box requests were sent")
  })
})

class FakeTransport implements BoxTemplateTransport {
  calls: string[] = []
  box: OwnedBox = { id: "bx_23456789", state: "ready", ownership: "created" }
  snapshot: OwnedSnapshot = { name: "waterbox-system-snapshot-1", state: "ready", snapshotArtifactId: "artifact-new", sourceBoxId: "bx_23456789", ownership: "created" }
  inspectBoxState: OwnedBox["state"] = "ready"
  inspectSnapshotState: OwnedSnapshot["state"] = "ready"
  foundSnapshot?: OwnedSnapshot
  snapshotInputs: Array<{ sourceId: string; name: string; signal: AbortSignal }> = []
  stopSignals: AbortSignal[] = []
  commandCount = 0
  failAt?: string
  async createSource(): Promise<OwnedBox> { this.calls.push("create"); if (this.failAt === "create") throw new Error("create failed"); return this.box }
  async inspectSource(id: string): Promise<{ id: string; state: OwnedBox["state"] }> { this.calls.push("inspect-box"); return { id, state: this.inspectBoxState } }
  async resumeSource(): Promise<void> { this.calls.push("resume"); this.inspectBoxState = "ready" }
  async upload(_id: string, _path: string, _bytes: Uint8Array, _signal: AbortSignal): Promise<void> { this.calls.push("upload"); if (this.failAt === "upload") throw new Error("upload failed") }
  async command(): Promise<void> { this.calls.push("command"); this.commandCount++; if (this.failAt === "command" || (this.failAt === "health" && this.commandCount === 2)) throw new Error(`${this.failAt} failed`) }
  async stopSource(_id: string, signal: AbortSignal): Promise<void> { this.calls.push("stop"); this.stopSignals.push(signal); if (this.failAt === "stop") throw new Error("stop failed"); this.inspectBoxState = "archived" }
  async findSnapshot(): Promise<OwnedSnapshot | undefined> { this.calls.push("find-snapshot"); return this.foundSnapshot }
  async createSnapshot(input: { sourceId: string; name: string; signal: AbortSignal }): Promise<OwnedSnapshot> { this.calls.push("snapshot"); this.snapshotInputs.push(input); if (this.failAt === "snapshot") throw new Error("snapshot failed"); return this.snapshot }
  async inspectSnapshot(name: string): Promise<{ name: string; state: OwnedSnapshot["state"]; snapshotArtifactId?: string; sourceBoxId?: string }> { this.calls.push("inspect-snapshot"); return { name, state: this.inspectSnapshotState, ...(this.snapshot.snapshotArtifactId ? { snapshotArtifactId: this.snapshot.snapshotArtifactId } : {}), ...(this.snapshot.sourceBoxId ? { sourceBoxId: this.snapshot.sourceBoxId } : {}) } }
  async deleteSnapshot(): Promise<void> { this.calls.push("delete-snapshot") }
  async deleteSource(): Promise<void> { this.calls.push("delete-source") }
}

function builderOverrides(transport: BoxTemplateTransport, values: { existing?: TemplateMetadata; metadataFailure?: boolean } = {}) {
  return { transport, fetch: async () => { throw new Error("network forbidden") }, buildArtifact: async () => {}, readArtifact: async () => new Uint8Array([9, 8, 7]), readMetadata: async () => values.existing, writeMetadata: async (_path: string, _metadata: TemplateMetadata) => { if (values.metadataFailure) throw new Error("metadata failed") }, sleep: async (_ms: number, signal: AbortSignal) => signal.throwIfAborted(), now: () => new Date("2026-08-26T00:00:00.000Z"), log: () => {} }
}

describe("repeatability and cleanup state machine", () => {
  test("completes a full fake build and exact rerun uses completed metadata without transport", async () => {
    const transport = new FakeTransport()
    const metadata = await buildBoxTemplate(isolated(), builderOverrides(transport))
    expect(metadata?.templateRef).toBe(transport.snapshot.name)
    expect(transport.calls).not.toContain("delete-source")
    const forbidden = new FakeTransport(); forbidden.failAt = "create"
    expect(await buildBoxTemplate(isolated(), builderOverrides(forbidden, { existing: metadata! }))).toEqual(metadata)
    expect(forbidden.calls).toEqual([])
  })

  test("changed config creates a distinct update while retaining pre-existing metadata artifact", async () => {
    const firstTransport = new FakeTransport(); const first = await buildBoxTemplate(isolated(), builderOverrides(firstTransport))
    const secondTransport = new FakeTransport(); secondTransport.snapshot = { name: "waterbox-system-snapshot-2", state: "ready", snapshotArtifactId: "artifact-newer", sourceBoxId: "bx_23456789", ownership: "created" }
    const second = await buildBoxTemplate(isolated({ daemonPort: 8081 }), builderOverrides(secondTransport, { existing: first! }))
    expect(second?.buildFingerprint).not.toBe(first?.buildFingerprint)
    expect(second?.templateRef).toBe(secondTransport.snapshot.name)
    expect(secondTransport.snapshotInputs[0]?.name).toBe(firstTransport.snapshotInputs[0]?.name)
    expect(secondTransport.calls).not.toContain("delete-snapshot")
  })

  test("resumes a stopped idempotent source and never deletes reused resources on failure", async () => {
    const transport = new FakeTransport(); transport.box = { id: "bx_23456789", state: "archived", ownership: "reused" }; transport.inspectBoxState = "archived"; transport.failAt = "upload"
    await expect(buildBoxTemplate(isolated(), builderOverrides(transport))).rejects.toThrow("upload failed")
    expect(transport.calls).toContain("resume")
    expect(transport.calls.at(-2)).toBe("stop")
    expect(transport.calls).not.toContain("delete-source")
    expect(transport.stopSignals.at(-1)?.aborted).toBe(false)
  })

  test("restores every failed reused-source stage to stopped with a fresh cleanup signal", async () => {
    for (const stage of ["upload", "command", "health", "snapshot", "metadata"] as const) {
      const transport = new FakeTransport(); transport.box = { id: "bx_23456789", state: "archived", ownership: "reused" }; transport.inspectBoxState = "archived"
      if (stage !== "metadata") transport.failAt = stage
      await expect(buildBoxTemplate(isolated(), builderOverrides(transport, { metadataFailure: stage === "metadata" }))).rejects.toThrow()
      expect(transport.calls).toContain("resume")
      expect(transport.calls.at(-2)).toBe("stop")
      expect(transport.calls.at(-1)).toBe("inspect-box")
      expect(transport.calls).not.toContain("delete-source")
      expect(transport.stopSignals.at(-1)?.aborted).toBe(false)
    }
  })

  test("replaces the single configured snapshot name while retaining fingerprint metadata", async () => {
    const artifact = new Uint8Array([9, 8, 7]); const fingerprint = buildFingerprint(config, artifact)
    const created = new FakeTransport(); await buildBoxTemplate(isolated(), builderOverrides(created))
    expect(created.snapshotInputs[0]).toEqual({ sourceId: "bx_23456789", name: snapshotBuildName(config.templateName), signal: expect.any(AbortSignal) })

    const dedup = new FakeTransport(); dedup.foundSnapshot = { name: "existing-snapshot", state: "ready", ownership: "reused" }
    const dedupMetadata = await buildBoxTemplate(isolated(), builderOverrides(dedup))
    expect(dedupMetadata?.templateRef).toBe(dedup.snapshot.name)
    expect(dedup.calls).toContain("snapshot")

  })

  test("cleans created source at stop failure and created snapshot plus source at metadata failure", async () => {
    const stopped = new FakeTransport(); stopped.failAt = "stop"
    await expect(buildBoxTemplate(isolated(), builderOverrides(stopped))).rejects.toThrow("stop failed")
    expect(stopped.calls.at(-1)).toBe("delete-source")
    const metadata = new FakeTransport()
    await expect(buildBoxTemplate(isolated(), builderOverrides(metadata, { metadataFailure: true }))).rejects.toThrow("metadata failed")
    expect(metadata.calls.slice(-2)).toEqual(["delete-snapshot", "delete-source"])
  })

  test("snapshot polling failure cleans only newly-created snapshot and source", async () => {
    const transport = new FakeTransport(); transport.inspectSnapshotState = "failed"
    await expect(buildBoxTemplate(isolated(), builderOverrides(transport))).rejects.toThrow("snapshot failed")
    expect(transport.calls.slice(-2)).toEqual(["delete-snapshot", "delete-source"])
  })

  test("stop polling timeout cleans the newly-created source", async () => {
    const transport = new FakeTransport()
    transport.stopSource = async () => { transport.calls.push("stop"); transport.inspectBoxState = "archiving" }
    let time = 0
    const overrides = builderOverrides(transport)
    await expect(buildBoxTemplate(isolated({ pollTimeoutMs: 2 }), { ...overrides, now: () => new Date(time++), sleep: async () => {} })).rejects.toThrow("timed out")
    expect(transport.calls.at(-1)).toBe("delete-source")
  })

  test("caller cancellation aborts a hung stage then uses a fresh cleanup signal", async () => {
    const transport = new FakeTransport()
    transport.upload = async (_id, _path, _bytes, signal) => { transport.calls.push("upload-hung"); await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }
    const controller = new AbortController(); const promise = buildBoxTemplate(isolated(), builderOverrides(transport), controller.signal)
    await Bun.sleep(2); controller.abort(new Error("signal-secret"))
    await expect(promise).rejects.toThrow("signal-secret")
    expect(transport.calls.at(-1)).toBe("delete-source")
  })

  test("reused-source cleanup remains bounded when a transport ignores its signal", async () => {
    const transport = new FakeTransport(); transport.box = { id: "bx_23456789", state: "archived", ownership: "reused" }; transport.inspectBoxState = "archived"; transport.failAt = "upload"
    transport.stopSource = async () => { transport.calls.push("stop-hung"); await new Promise(() => {}) }
    const started = performance.now()
    await expect(buildBoxTemplate(isolated({ requestTimeoutMs: 5 }), builderOverrides(transport))).rejects.toThrow("upload failed")
    expect(performance.now() - started).toBeLessThan(100)
    expect(transport.calls).not.toContain("delete-source")
  })
})

describe("strict bounded HTTP transport and durable metadata", () => {
  test("replays a lost create response with the exact documented key and body", async () => {
    const seen: Array<{ key: string | null; body: string }> = []; let calls = 0
    const transport = new HttpBoxTemplateTransport(config, async (_input, init) => { seen.push({ key: new Headers(init?.headers).get("idempotency-key"), body: String(init?.body) }); if (++calls === 1) throw new TypeError("lost response"); return Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "provisioning" } }, { status: 202 }) })
    await expect(transport.createSource({ idempotencyKey: sourceKey, ownership: "created", signal: new AbortController().signal })).resolves.toMatchObject({ id: "bx_23456789", ownership: "created" })
    expect(seen).toHaveLength(2); expect(seen[1]).toEqual(seen[0])
  })

  test("rejects corrupt journals and concurrent journal locks before provider work", async () => {
    const directory = await mkdtemp(join(testRoot, "waterbox-journal-")); const metadataPath = join(directory, "metadata.json"); const transport = new FakeTransport()
    await writeFile(`${metadataPath}.operation`, "not-json")
    await expect(buildBoxTemplate({ ...config, metadataPath }, builderOverrides(transport))).rejects.toThrow("journal is corrupt")
    expect(transport.calls).toEqual([])
    await Bun.file(`${metadataPath}.operation`).delete(); await writeFile(`${metadataPath}.operation.lock`, "held")
    await expect(buildBoxTemplate({ ...config, metadataPath }, builderOverrides(transport))).rejects.toThrow()
    expect(transport.calls).toEqual([])
  })

  test("fails closed for expired journals without replaying the provider operation", async () => {
    const directory = await mkdtemp(join(testRoot, "waterbox-stale-journal-")); const metadataPath = join(directory, "metadata.json"); const transport = new FakeTransport()
    const artifact = new Uint8Array([9, 8, 7]); const fingerprint = buildFingerprint(config, artifact)
    const body = { noEnv: true, env: { WATERBOX_BUILD_FINGERPRINT: fingerprint } }
    const createBodyDigest = createHash("sha256").update(JSON.stringify(body)).digest("hex")
    await writeFile(`${metadataPath}.operation`, JSON.stringify({ version: 1, buildFingerprint: fingerprint, idempotencyKey: `waterbox-template-${fingerprint}`, createBodyDigest, stage: "pre_create", updatedAt: "2026-08-24T00:00:00.000Z" }))
    await expect(buildBoxTemplate({ ...config, metadataPath }, builderOverrides(transport))).rejects.toThrow("stale")
    expect(transport.calls).toEqual([])
  })

  test("retains journal and skips every destructive cleanup on competing snapshot recovery", async () => {
    const directory = await mkdtemp(join(testRoot, "waterbox-race-journal-")); const metadataPath = join(directory, "metadata.json"); const transport = new FakeTransport()
    transport.inspectBoxState = "archived"
    transport.foundSnapshot = { name: config.templateName, state: "saving", sourceBoxId: "bx_abcdefgh", ownership: "reused" }
    const artifact = new Uint8Array([9, 8, 7]); const fingerprint = buildFingerprint(config, artifact)
    const createBodyDigest = createHash("sha256").update(JSON.stringify({ noEnv: true, env: { WATERBOX_BUILD_FINGERPRINT: fingerprint } })).digest("hex")
    const journal = { version: 1, buildFingerprint: fingerprint, idempotencyKey: `waterbox-template-${fingerprint}`, createBodyDigest, stage: "snapshot_saving", updatedAt: "2026-08-26T00:00:00.000Z", boxId: "bx_23456789", snapshotName: config.templateName, snapshotSourceBoxId: "bx_23456789" }
    await writeFile(`${metadataPath}.operation`, JSON.stringify(journal))
    const logs: string[] = []
    await expect(buildBoxTemplate({ ...config, metadataPath }, { ...builderOverrides(transport), log: message => logs.push(message) })).rejects.toThrow("manual recovery required")
    expect(transport.calls).not.toContain("delete-source")
    expect(transport.calls).not.toContain("delete-snapshot")
    expect(JSON.parse(await readFile(`${metadataPath}.operation`, "utf8"))).toEqual(journal)
    expect(logs.some(message => message.includes("MANUAL RECOVERY REQUIRED"))).toBe(true)
  })

  test("retains snapshot-saving evidence and deletes nothing on a post-save polling race", async () => {
    const transport = new FakeTransport(); const buildConfig = isolated(); const logs: string[] = []
    transport.inspectSnapshot = async (name) => { transport.calls.push("inspect-snapshot"); return { name, state: "saving", snapshotArtifactId: "competitor-artifact", sourceBoxId: "bx_abcdefgh" } }
    await expect(buildBoxTemplate(buildConfig, { ...builderOverrides(transport), log: message => logs.push(message) })).rejects.toThrow("manual recovery required")
    expect(transport.calls).not.toContain("delete-source")
    expect(transport.calls).not.toContain("delete-snapshot")
    const journal = JSON.parse(await readFile(`${buildConfig.metadataPath}.operation`, "utf8"))
    expect(journal).toMatchObject({ stage: "snapshot_saving", boxId: "bx_23456789", snapshotName: config.templateName, snapshotSourceBoxId: "bx_23456789" })
    expect(logs.some(message => message.includes("MANUAL RECOVERY REQUIRED"))).toBe(true)
  })

  test("reconciles only ambiguous snapshot saves and rejects an unchanged old artifact", async () => {
    const oldReady = { ok: true, type: "snapshot.named.info", snapshot: { name: config.templateName, status: "ready", snapshotId: "artifact-old", sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00Z" } }
    const saving = { ok: true, type: "snapshot.named.info", snapshot: { name: config.templateName, status: "saving", snapshotId: "artifact-new", sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00Z" } }
    for (const scenario of ["definite", "accepted", "old-only"] as const) {
      let gets = 0; let posts = 0
      const transport = new HttpBoxTemplateTransport(config, async (_input, init) => {
        if (init?.method === "GET") { gets++; return Response.json(scenario === "accepted" && gets === 2 ? saving : oldReady) }
        posts++
        if (scenario === "definite") return Response.json({ ok: false, type: "error", error: { code: "conflict", message: "conflict" } }, { status: 409 })
        throw new TypeError("lost response")
      })
      const result = transport.createSnapshot({ sourceId: "bx_23456789", name: config.templateName, signal: new AbortController().signal })
      if (scenario === "accepted") await expect(result).resolves.toMatchObject({ state: "saving", snapshotArtifactId: "artifact-new", ownership: "reused" })
      else await expect(result).rejects.toThrow(scenario === "definite" ? "409" : "ambiguous")
      expect(posts).toBe(1)
      expect(gets).toBe(scenario === "definite" ? 1 : 2)
    }
  })

  test("requires official source and creation time on snapshot preflight, save, and polling", async () => {
    const base = { name: config.templateName, status: "saving", sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00Z" }
    for (const snapshot of [{ ...base, sourceBoxId: undefined }, { ...base, createdAt: undefined }, { ...base, createdAt: "not-a-date" }]) {
      const response = () => Response.json({ ok: true, type: "snapshot.named.info", snapshot })
      await expect(new HttpBoxTemplateTransport(config, async () => response()).findSnapshot(config.templateName, new AbortController().signal)).rejects.toThrow("invalid named snapshot")
      await expect(new HttpBoxTemplateTransport(config, async () => response()).inspectSnapshot(config.templateName, new AbortController().signal, "bx_23456789")).rejects.toThrow("invalid named snapshot")
      let calls = 0
      const save = new HttpBoxTemplateTransport(config, async () => { calls++; return calls === 1 ? new Response(null, { status: 404 }) : Response.json({ ok: true, type: "snapshot.named.saving", snapshot }, { status: 202 }) })
      await expect(save.createSnapshot({ sourceId: "bx_23456789", name: config.templateName, signal: new AbortController().signal })).rejects.toThrow("invalid named snapshot")
    }
  })

  test("publishes replacement metadata only after a new snapshot artifact is ready", async () => {
    const transport = new FakeTransport()
    transport.foundSnapshot = { name: config.templateName, state: "ready", snapshotArtifactId: "artifact-old", ownership: "reused" }
    transport.snapshot = { name: config.templateName, state: "saving", snapshotArtifactId: "artifact-new", sourceBoxId: "bx_23456789", ownership: "reused" }
    transport.inspectSnapshotState = "ready"
    const metadata = await buildBoxTemplate(isolated(), builderOverrides(transport))
    expect(metadata?.templateRef).toBe(config.templateName)
    expect(metadata?.snapshotArtifactId).toBe("artifact-new")
    expect(transport.calls).not.toContain("delete-snapshot")
  })

  test("rejects malformed, extra, mismatched, unknown-state, and oversized DTOs", async () => {
    for (const payload of [{ id: "bx_23456789", state: "ready", extra: true }, { id: "", state: "ready" }, { id: "bx_23456789", state: "mystery" }]) {
      const transport = new HttpBoxTemplateTransport(config, async () => Response.json(payload, { status: 202 }))
      await expect(transport.createSource({ idempotencyKey: sourceKey, ownership: "created", signal: new AbortController().signal })).rejects.toThrow(/invalid .*response/)
    }
    const oversized = new HttpBoxTemplateTransport(config, async () => new Response(new Uint8Array(1_048_577), { status: 202, headers: { "content-type": "application/json" } }))
    await expect(oversized.createSource({ idempotencyKey: sourceKey, ownership: "created", signal: new AbortController().signal })).rejects.toThrow("too large")
  })

  test("request timeout promptly aborts a hung fetch", async () => {
    const transport = new HttpBoxTemplateTransport({ ...config, requestTimeoutMs: 5 }, async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })))
    await expect(transport.createSource({ idempotencyKey: sourceKey, ownership: "created", signal: new AbortController().signal })).rejects.toThrow()
  })

  test("keeps per-request timeout alive through a never-ending body and then cleans the owned source", async () => {
    let cancelled = 0; let deleted = 0
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.endsWith("/boxes") && init?.method === "POST") return Response.json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "ready" } }, { status: 202 })
      if (url.endsWith("/boxes/bx_23456789") && init?.method === "GET") return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true')) }, cancel() { cancelled++ } }), { headers: { "content-type": "application/json" } })
      if (url.endsWith("/boxes/bx_23456789") && init?.method === "DELETE") { deleted++; return Response.json({ ok: true, type: "box.deleting", operation: { id: `bdop_${"a".repeat(32)}`, kind: "box", targetId: "bx_23456789", status: "completed" } }, { status: 202 }) }
      throw new Error(`unexpected ${init?.method} ${url}`)
    }
    const started = performance.now()
    await expect(buildBoxTemplate(isolated({ requestTimeoutMs: 20 }), { fetch: fakeFetch, buildArtifact: async () => {}, readArtifact: async () => new Uint8Array([1]), readMetadata: async () => undefined, log: () => {} })).rejects.toMatchObject({ name: "Error", message: "Box request timed out" })
    expect(performance.now() - started).toBeLessThan(100)
    expect(cancelled).toBe(1)
    expect(deleted).toBe(1)
  })

  test("accepts a slow body within the request bound and preserves caller-abort precedence", async () => {
    const payload = new TextEncoder().encode('{"ok":true,"type":"box.created","status":"provisioning","ttlSeconds":3600,"box":{"id":"bx_23456789","state":"ready"}}')
    const slow = new HttpBoxTemplateTransport({ ...config, requestTimeoutMs: 50 }, async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { setTimeout(() => { controller.enqueue(payload); controller.close() }, 5) } }), { status: 202, headers: { "content-type": "application/json", "content-length": String(payload.length) } }))
    await expect(slow.createSource({ idempotencyKey: sourceKey, ownership: "created", signal: new AbortController().signal })).resolves.toMatchObject({ id: "bx_23456789" })

    let cancelled = 0
    const caller = new AbortController(); const reason = new Error("caller-wins")
    const hung = new HttpBoxTemplateTransport({ ...config, requestTimeoutMs: 50 }, async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++ } }), { status: 202, headers: { "content-type": "application/json" } }))
    const pending = hung.createSource({ idempotencyKey: sourceKey, ownership: "created", signal: caller.signal })
    setTimeout(() => caller.abort(reason), 2)
    await expect(pending).rejects.toBe(reason)
    expect(cancelled).toBe(1)
  })

  test("enforces canonical exact Content-Length and reads through delayed trailing bytes", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 3600, box: { id: "bx_23456789", state: "ready" } }))
    const invoke = (response: Response) => new HttpBoxTemplateTransport(config, async () => response).createSource({ idempotencyKey: sourceKey, ownership: "created", signal: new AbortController().signal })
    await expect(invoke(new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }), { status: 202, headers: { "content-type": "application/json", "content-length": String(bytes.length) } }))).resolves.toMatchObject({ id: "bx_23456789" })
    for (const length of [String(bytes.length + 1), String(bytes.length - 1), `0${bytes.length}`, "+1", " 1"])
      await expect(invoke(new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }), { status: 202, headers: { "content-type": "application/json", "content-length": length } }))).rejects.toThrow(/Content-Length|invalid/)
    const delayed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); setTimeout(() => { controller.enqueue(new Uint8Array([32])); controller.close() }, 2) } })
    await expect(invoke(new Response(delayed, { status: 202, headers: { "content-type": "application/json", "content-length": String(bytes.length) } }))).rejects.toThrow("Content-Length mismatch")
  })

  test("attempts detached cancellation on every early framing failure, including hostile cancellation", async () => {
    const valid = new TextEncoder().encode('{"ok":true,"type":"box.created","status":"provisioning","ttlSeconds":3600,"box":{"id":"bx_23456789","state":"ready"}}')
    const invoke = (response: Response) => new HttpBoxTemplateTransport(config, async () => response).createSource({ idempotencyKey: sourceKey, ownership: "created", signal: new AbortController().signal })
    for (const cancellation of ["resolve", "reject", "never"] as const) {
      let cancelled = 0
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(valid) }, cancel() { cancelled++; if (cancellation === "reject") return Promise.reject(new Error("hostile")); if (cancellation === "never") return new Promise(() => {}); return undefined } })
      await expect(invoke(new Response(stream, { status: 202, headers: { "content-type": "text/plain" } }))).rejects.toThrow("media type")
      expect(cancelled).toBe(1)
    }
    let oversizedCancelled = 0
    const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(valid) }, cancel() { oversizedCancelled++ } })
    await expect(invoke(new Response(oversized, { status: 202, headers: { "content-type": "application/json", "content-length": "1048577" } }))).rejects.toThrow("too large")
    expect(oversizedCancelled).toBe(1)
  })

  test("writes strict metadata atomically and rejects concurrent writer or symlink target", async () => {
    const directory = await mkdtemp(join(testRoot, "waterbox-metadata-")); const path = join(directory, "deployment.json")
    const metadata = parseTemplateMetadata({ version: 1, provider: "box", templateRef: "snap-1", templateName: "name", buildFingerprint: "b".repeat(64), artifactSha256: "a".repeat(64), snapshotArtifactId: "artifact-1", daemonPort: 8080, builtAt: "2026-08-26T00:00:00.000Z" })
    await atomicMetadataWrite(path, metadata); expect(parseTemplateMetadata(JSON.parse(await readFile(path, "utf8")))).toEqual(metadata)
    await writeFile(`${path}.lock`, "held")
    await expect(atomicMetadataWrite(path, metadata)).rejects.toThrow()
    expect(await readFile(`${path}.lock`, "utf8")).toBe("held")
    const target = join(directory, "target"); await symlink(path, target)
    await expect(atomicMetadataWrite(target, metadata)).rejects.toThrow("unsafe")
  })
})
