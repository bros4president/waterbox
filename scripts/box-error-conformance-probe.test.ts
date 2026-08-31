import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadBoxErrorProbeConfig, runBoxErrorConformanceProbe, writeProbeArtifacts, type BoxErrorProbeConfig, type ProbeArtifact } from "./box-error-conformance-probe.ts"

const authorization = "I_UNDERSTAND_THIS_ERROR_PROBE_CREATES_STOPS_RESUMES_SNAPSHOTS_AND_PERMANENTLY_DELETES_BOX_RESOURCES"
const config: BoxErrorProbeConfig = { apiBaseUrl: "https://api.box.test/v1", apiKey: "box-secret", artifactDirectory: ".waterbox/probes", pollIntervalMs: 1, pollTimeoutMs: 100, requestTimeoutMs: 100 }
const boxId = "bx_23456789", deletionId = `bdop_${"a".repeat(32)}`
const temporary: string[] = []

afterEach(async () => { for (const path of temporary.splice(0)) await chmod(path, 0o700).catch(() => {}) })

describe("Box error conformance probe", () => {
  test("requires all live gates and a credential-free HTTPS URL before fetch is injectable", () => {
    const valid = { BOX_API_KEY: "key", BOX_ERROR_CONFORMANCE_PROBE_AUTHORIZATION: authorization, WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "YES" }
    for (const [env, argv] of [[{}, ["--run"]], [valid, []], [{ ...valid, WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "NO" }, ["--run"]], [{ ...valid, BOX_API_BASE_URL: "http://api.test" }, ["--run"]], [{ ...valid, BOX_API_BASE_URL: "https://u:p@api.test" }, ["--run"]]] as const) expect(() => loadBoxErrorProbeConfig(env, argv, false)).toThrow()
    expect(loadBoxErrorProbeConfig(valid, ["--run"], false).apiKey).toBe("key")
    expect(() => loadBoxErrorProbeConfig(valid, ["--run"], true)).toThrow("bun test")
  })

  test("runs declared requests, never mutates baseline, and does not implicitly retry mutations", async () => {
    const requests: Request[] = []; let create = 0; let list = 0; let snapshotGet = 0; let state = "ready"; let deleted = false
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request.clone()); const path = new URL(request.url).pathname; const body = request.body ? await request.clone().json() as any : undefined
      if (path.endsWith("/limits")) return json({ ok: true, type: "limits.info", activeBoxes: list > 1 ? 1 : 1, maxActiveBoxes: 5, canStart: true })
      if (path.endsWith("/boxes") && request.method === "GET") { list++; return json({ ok: true, type: "box.list", boxes: [{ id: "bx_baseline", state: "ready" }] }) }
      if (path.endsWith("/boxes") && request.method === "POST") { create++; if (body.from) return error(404, "snapshot_not_found"); if (create === 4) throw new TypeError("lost response"); return json({ ok: true, type: "box.created", box: { id: boxId, state: "ready" }, status: "ready" }, 202) }
      if (path.includes("/named-snapshots/") && request.method === "GET") { snapshotGet++; return snapshotGet > 1 ? json({ ok: true, type: "snapshot.named.info", snapshot: { name: decodeURIComponent(path.split("/").at(-1)!), sourceBoxId: boxId, status: "ready", snapshotId: "snap_raw" } }) : error(404, "snapshot_not_found") }
      if (path.endsWith("/named-snapshots") && request.method === "POST") return json({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { name: body.name, sourceBoxId: boxId, status: "saving" } }, 202)
      if (path.includes("/named-snapshots/") && request.method === "DELETE") return json({ ok: true, type: "snapshot.named.deleted", name: decodeURIComponent(path.split("/").at(-1)!), status: "deleted" })
      if (path.endsWith("/stop")) { state = "archived"; return json({ ok: true, type: "box.stopping", id: boxId, status: "archiving" }, 202) }
      if (path.endsWith("/resume")) { state = "ready"; return json({ ok: true, type: "box.resuming", id: boxId, status: "resuming" }, 202) }
      if (path.endsWith("/commands")) return error(409, "invalid_state")
      if (path.includes("/deletion-operations/")) return path.endsWith(deletionId) ? json({ ok: true, type: "deletion.operation", operation: { id: deletionId, kind: "box", targetId: boxId, status: "completed" } }) : error(404, "deletion_not_found")
      if (path.endsWith(`/boxes/${boxId}`) && request.method === "DELETE") { if (deleted) return error(404, "box_not_found"); deleted = true; return json({ ok: true, type: "box.deleting", operation: { id: deletionId, kind: "box", targetId: boxId, status: "completed" } }, 202) }
      if (path.endsWith(`/boxes/${boxId}`) && request.method === "GET") return deleted ? error(404, "box_not_found") : json({ ok: true, type: "box.info", box: { id: boxId, state } })
      return error(request.headers.get("authorization") === "Bearer deliberately-invalid-box-key" ? 401 : 404, "box_not_found")
    }
    const artifacts: ProbeArtifact[] = [], logs: string[] = []
    await expect(runBoxErrorConformanceProbe(config, deps(fetcher, artifacts, logs))).resolves.toMatchObject({ artifact: { cleanup: { complete: true } } })
    expect(requests.some(request => new URL(request.url).pathname.includes("bx_baseline") && request.method !== "GET")).toBe(false)
    const lostBody = JSON.stringify({ noEnv: true, ttlSeconds: 300 })
    expect(requests.filter(request => request.method === "POST" && request.headers.get("idempotency-key")?.includes("concurrent"))).toHaveLength(2)
    expect(requests.filter(request => request.method === "POST" && request.body && request.headers.get("idempotency-key") === "lost")).toHaveLength(0)
    expect(JSON.stringify(artifacts)).not.toContain(config.apiKey)
    expect(JSON.stringify(logs)).not.toContain(boxId)
    expect(lostBody).not.toBe("")
    const caseIds = new Set(artifacts[0]!.cases.map(item => item.caseId))
    for (const caseId of ["1", "2", "3.stop", "3.resume", "3.delete", "4", "5", "6", "7", "8", "9", "10", "11.create", "11.replay", "11.conflict", "12.a", "12.b", "13", "14.stop", "14.repeat", "15.resume", "15.repeat", "16.save", "16.duplicate", "16.delete-while-saving", "16.delete", "16.repeat-delete", "17.delete", "17.repeat-delete", "17.target-inspect"]) expect(caseIds.has(caseId)).toBe(true)
  })

  test("cleans only a tracked Box when a later probe stage fails", async () => {
    const requests: Request[] = []; let creates = 0
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request.clone()); const path = new URL(request.url).pathname; const body = request.body ? await request.clone().json() as any : undefined
      if (path.endsWith("/limits")) return json({ ok: true, type: "limits.info", activeBoxes: 0, maxActiveBoxes: 2, canStart: true })
      if (path.endsWith("/boxes") && request.method === "GET") return json({ ok: true, type: "box.list", boxes: [] })
      if (path.endsWith("/boxes") && request.method === "POST") { if (body.from) return error(404, "snapshot_not_found"); creates++; return json({ ok: true, type: "box.created", box: { id: boxId, state: "error" }, status: "error" }, 202) }
      if (path.endsWith(`/boxes/${boxId}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: boxId, state: "error" } })
      if (path.endsWith(`/boxes/${boxId}`) && request.method === "DELETE") return json({ ok: true, type: "box.deleting", operation: { id: deletionId, kind: "box", targetId: boxId, status: "completed" } }, 202)
      if (path.endsWith(`/deletion-operations/${deletionId}`)) return json({ ok: true, type: "deletion.operation", operation: { id: deletionId, kind: "box", targetId: boxId, status: "completed" } })
      if (path.includes("/named-snapshots/") && request.method === "DELETE") return error(404, "not_found")
      if (path.endsWith("/named-snapshots") && request.method === "POST") return error(404, "not_found")
      return error(request.headers.get("authorization") === "Bearer deliberately-invalid-box-key" ? 401 : 404, "not_found")
    }
    await expect(runBoxErrorConformanceProbe(config, deps(fetcher))).rejects.toThrow("Box state reconciliation failed")
    expect(creates).toBeGreaterThan(0)
    expect(requests.some(request => request.method === "DELETE" && new URL(request.url).pathname.endsWith(boxId) && request.headers.get("x-ascii-confirm-delete") === boxId)).toBe(true)
    expect(requests.some(request => request.method !== "GET" && new URL(request.url).pathname.includes("baseline"))).toBe(false)
  })

  test("reconciles a lost keyed-create response with one exact replay and one owned identity", async () => {
    const scenario = conformanceScenario("create")
    const artifacts: ProbeArtifact[] = []
    await expect(runBoxErrorConformanceProbe(config, deps(scenario.fetch, artifacts))).resolves.toMatchObject({ artifact: { cleanup: { complete: true } } })

    const primaryCreates = scenario.requests.filter(request => request.method === "POST" && request.headers.get("idempotency-key")?.endsWith("-create"))
    const primaryBodies = await Promise.all(primaryCreates.map(request => request.clone().text()))
    expect(primaryBodies.filter(body => body === JSON.stringify({ noEnv: true, ttlSeconds: 300 }))).toHaveLength(3)
    const primaryCases = artifacts[0]!.cases.filter(item => item.caseId === "11.create" || item.caseId === "11.create.reconcile" || item.caseId === "11.replay")
    expect(primaryCases.map(item => item.certainty)).toEqual(["transport-uncertain", "observed", "observed"])
    expect(artifacts[0]!.tracked.boxIds.filter(id => id === boxId)).toHaveLength(1)
  })

  test("records a lost command response once and aborts to cleanup without replay", async () => {
    const scenario = conformanceScenario("command")
    const artifacts: ProbeArtifact[] = []
    await expect(runBoxErrorConformanceProbe(config, deps(scenario.fetch, artifacts))).rejects.toThrow("unreconciled mutation outcome: 13")
    const commands = scenario.requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith(`/boxes/${boxId}/commands`))
    expect(commands).toHaveLength(1)
    expect(artifacts[0]!.cases.find(item => item.caseId === "13")?.certainty).toBe("transport-uncertain")
  })

  test("reconciles lost lifecycle and snapshot responses read-only before another mutation", async () => {
    for (const fault of ["stop", "resume", "box-delete", "snapshot-save", "snapshot-delete"] as const) {
      const scenario = conformanceScenario(fault)
      await expect(runBoxErrorConformanceProbe(config, deps(scenario.fetch))).resolves.toMatchObject({ artifact: { cleanup: { complete: true } } })
      const faultIndex = scenario.faultIndex
      expect(faultIndex).toBeGreaterThan(-1)
      const nextMutation = scenario.requests.findIndex((request, index) => index > faultIndex && request.method !== "GET")
      const reconciliationRead = scenario.requests.findIndex((request, index) => index > faultIndex && request.method === "GET")
      expect(reconciliationRead).toBeGreaterThan(faultIndex)
      expect(nextMutation).toBeGreaterThan(reconciliationRead)
    }
  })

  test("fails ownership reconciliation when an uncertain create replay is not a successful identity", async () => {
    const scenario = conformanceScenario("create-replay-rejected")
    await expect(runBoxErrorConformanceProbe(config, deps(scenario.fetch))).rejects.toThrow("unreconciled ownership blocker")
    const primaryCreates = scenario.requests.filter(request => request.method === "POST" && request.headers.get("idempotency-key")?.endsWith("-create"))
    expect(primaryCreates).toHaveLength(2)
  })

  test("blocks on an unknown final Box without deleting it", async () => {
    const requests: Request[] = []
    let listCount = 0
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request.clone())
      const path = new URL(request.url).pathname
      if (path.endsWith("/limits")) return json({ ok: true, type: "limits.info", activeBoxes: 0, maxActiveBoxes: 5, canStart: true })
      if (path.endsWith("/boxes") && request.method === "GET") return json({ ok: true, type: "box.list", boxes: listCount++ === 0 ? [] : [{ id: "bx_3456789a", state: "ready" }] })
      if (path.endsWith("/commands")) throw new TypeError("synthetic lost response")
      return error(request.headers.get("authorization") === "Bearer deliberately-invalid-box-key" ? 401 : 404, "not_found")
    }
    await expect(runBoxErrorConformanceProbe(config, deps(fetcher))).rejects.toThrow("final baseline reconciliation failed")
    expect(requests.some(request => request.method === "DELETE" && new URL(request.url).pathname.endsWith("bx_3456789a"))).toBe(false)
  })

  test("bounds captures and records non-JSON and behavior differences without throwing", async () => {
    const artifacts: ProbeArtifact[] = []
    const fetcher = async () => new Response("not json", { status: 418, headers: { "content-type": "text/plain" } })
    await expect(runBoxErrorConformanceProbe(config, deps(fetcher, artifacts))).rejects.toThrow("baseline")
    expect(artifacts[0]?.cases[0]).toMatchObject({ response: { status: 418, bodyKind: "text" } })
    expect(JSON.stringify(artifacts[0])).not.toContain("not json")
    const oversized = async () => new Response(new Uint8Array(1_048_577), { headers: { "content-type": "application/json" } })
    await expect(runBoxErrorConformanceProbe(config, deps(oversized, []))).rejects.toThrow("capture infrastructure")
  })

  test("writes private raw and correlated sanitized artifacts without credentials, URLs, IDs, names, messages, or request IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "box-probe-")); temporary.push(directory)
    const raw: ProbeArtifact = { schemaVersion: 1, run: "run-secret", startedAt: "2026-08-30T00:00:00.000Z", baseline: { visibleIds: [boxId], activeCount: 1 }, cases: [{ caseId: "x", operation: "inspect", request: { method: "GET", pathTemplate: "/boxes/{boxId}", mutation: false }, response: { status: 404, contentType: "application/json", bodyKind: "json", body: { ok: false, code: "box_not_found", message: "secret raw message", requestId: "req_secret", id: boxId }, bodyShapeKeys: ["code", "message", "ok", "requestId"], messageLength: 18, messageSha256: "abc", requestIdPresent: true }, expectation: "404", certainty: "observed" }], tracked: { boxIds: [boxId], deletionIds: [deletionId], snapshotNames: ["waterbox-error-run-secret"] }, cleanup: { complete: true, baselinePreserved: true, trackedBoxesAbsent: true, activeCountRestored: true } }
    const paths = await writeProbeArtifacts(directory, raw)
    expect((await stat(paths.raw)).mode & 0o777).toBe(0o600); expect((await stat(paths.sanitized)).mode & 0o777).toBe(0o600)
    const rawText = await readFile(paths.raw, "utf8"), safe = await readFile(paths.sanitized, "utf8")
    expect(rawText).toContain(boxId); expect(rawText).not.toContain(config.apiKey); expect(rawText).not.toContain(config.apiBaseUrl)
    for (const value of [boxId, deletionId, "waterbox-error-run-secret", "req_secret", "secret raw message", "2026-08-30T00:00:00.000Z"]) expect(safe).not.toContain(value)
    expect(safe).toContain("[BOX_1]"); expect(safe).toContain("abc")
  })
})

function deps(fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, artifacts: ProbeArtifact[] = [], logs: string[] = []) { let tick = 0; return { fetch: fetcher, sleep: async () => {}, random: () => "0123456789abcdef0123456789abcdef", now: () => new Date(Date.parse("2026-08-30T00:00:00.000Z") + tick++), writeArtifacts: async (artifact: ProbeArtifact) => { artifacts.push(structuredClone(artifact)); return { raw: "/raw", sanitized: "/safe" } }, log: (line: string) => logs.push(line) } }
function json(value: unknown, status = 200) { return Response.json(value, { status }) }
function error(status: number, code: string) { return json({ ok: false, type: "box.error", status, code, message: `${code} raw`, requestId: "req_raw", error: { code, status, message: `${code} raw` } }, status) }

type ScenarioFault = "create" | "create-replay-rejected" | "command" | "stop" | "resume" | "box-delete" | "snapshot-save" | "snapshot-delete"

function conformanceScenario(fault: ScenarioFault) {
  const requests: Request[] = []
  const boxes = new Set<string>()
  const concurrentBox = "bx_2345678a"
  let state = "ready", snapshotExists = false, snapshotDeleteCount = 0, faulted = false, faultIndex = -1
  const lose = () => { faulted = true; faultIndex = requests.length - 1; throw new TypeError("synthetic lost response") }
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init); requests.push(request.clone())
    const path = new URL(request.url).pathname
    const body = request.body ? await request.clone().json() as any : undefined
    const key = request.headers.get("idempotency-key") ?? ""
    if (path.endsWith("/limits")) return json({ ok: true, type: "limits.info", activeBoxes: 0, maxActiveBoxes: 5, canStart: true })
    if (path.endsWith("/boxes") && request.method === "GET") return json({ ok: true, type: "box.list", boxes: [] })
    if (path.endsWith("/boxes") && request.method === "POST") {
      if (body.from) return error(404, "snapshot_not_found")
      if (key.endsWith("-create") && body.ttlSeconds === 301) return error(409, "idempotency_key_reused")
      const id = key.includes("concurrent") ? concurrentBox : boxId
      boxes.add(id)
      if (!faulted && (fault === "create" || fault === "create-replay-rejected") && key.endsWith("-create")) lose()
      if (fault === "create-replay-rejected" && faulted && key.endsWith("-create")) return error(429, "rate_limited")
      return json({ ok: true, type: "box.created", box: { id, state }, status: state }, 202)
    }
    if (path.endsWith(`/boxes/${boxId}/commands`) && request.method === "POST") {
      if (!faulted && fault === "command") lose()
      return error(409, "invalid_state")
    }
    if (path.endsWith(`/boxes/${boxId}/stop`) && request.method === "POST") {
      state = "archived"
      if (!faulted && fault === "stop") lose()
      return json({ ok: true, type: "box.stopping", id: boxId, status: "archiving" }, 202)
    }
    if (path.endsWith(`/boxes/${boxId}/resume`) && request.method === "POST") {
      state = "ready"
      if (!faulted && fault === "resume") lose()
      return json({ ok: true, type: "box.resuming", id: boxId, status: "resuming" }, 202)
    }
    if (path.endsWith("/named-snapshots") && request.method === "POST") {
      if (body.boxId !== boxId) return error(404, "not_found")
      if (snapshotExists) return error(409, "save_in_progress")
      snapshotExists = true
      if (!faulted && fault === "snapshot-save") lose()
      return json({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { name: body.name, sourceBoxId: boxId, status: "ready" } }, 202)
    }
    if (path.includes("/named-snapshots/") && request.method === "GET") {
      if (!snapshotExists) return error(404, "not_found")
      return json({ ok: true, type: "snapshot.named.info", snapshot: { name: path.split("/").at(-1), sourceBoxId: boxId, status: "ready" } })
    }
    if (path.includes("/named-snapshots/") && request.method === "DELETE") {
      if (!snapshotExists) return error(404, "not_found")
      snapshotDeleteCount++
      if (snapshotDeleteCount === 1 && fault !== "snapshot-delete") return error(409, "save_in_progress")
      snapshotExists = false
      if (!faulted && fault === "snapshot-delete") lose()
      return json({ ok: true, type: "snapshot.named.deleted", status: "deleted" })
    }
    if (path.includes("/deletion-operations/")) return json({ ok: true, type: "deletion.operation", operation: { id: deletionId, kind: "box", targetId: boxId, status: "completed" } })
    const matchedBox = path.match(/\/boxes\/(bx_[^/]+)$/)?.[1]
    if (matchedBox && request.method === "GET") return boxes.has(matchedBox) ? json({ ok: true, type: "box.info", box: { id: matchedBox, state: matchedBox === boxId ? state : "ready" } }) : error(404, "not_found")
    if (matchedBox && request.method === "DELETE") {
      if (!boxes.has(matchedBox)) return error(404, "not_found")
      boxes.delete(matchedBox)
      if (!faulted && fault === "box-delete" && matchedBox === boxId) lose()
      return json({ ok: true, type: "box.deleting", operation: { id: deletionId, kind: "box", targetId: matchedBox, status: "completed" } }, 202)
    }
    return error(request.headers.get("authorization") === "Bearer deliberately-invalid-box-key" ? 401 : 404, "not_found")
  }
  return { fetch, requests, get faultIndex() { return faultIndex } }
}
