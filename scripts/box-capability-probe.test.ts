import { describe, expect, test } from "bun:test"
import { loadProbeConfig, reconcileProbeBoxesReleased, runBoxCapabilityProbe, type ProbeConfig } from "./box-capability-probe.ts"

const config: ProbeConfig = { apiBaseUrl: "https://api.box.test", apiKey: "box-secret-key", pollIntervalMs: 1, pollTimeoutMs: 1000, requestTimeoutMs: 1000 }
const source = "bx_23456789"
const restored = "bx_abcdefgh"
const operation = `bdop_${"a".repeat(32)}`

describe("Box capability probe", () => {
  test("requires credential, explicit CLI, and exact environment authorization before a fetch can exist", () => {
    for (const [env, argv] of [[{}, []], [{ BOX_API_KEY: "key" }, ["--run"]], [{ BOX_API_KEY: "key", BOX_CAPABILITY_PROBE_AUTHORIZATION: "yes" }, ["--run"]]] as const) expect(() => loadProbeConfig(env, argv)).toThrow()
    expect(loadProbeConfig({ BOX_API_KEY: "key", BOX_CAPABILITY_PROBE_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES" }, ["--run"]).apiKey).toBe("key")
  })

  test("accepts immediate probe resource release", async () => {
    await expect(reconcileProbeBoxesReleased([source], 1, releaseSnapshots([{ visibleIds: [], activeBoxes: 1 }]), releaseOptions())).resolves.toEqual({ visibleSetReleased: true, activeCountReleased: true, activeBoxes: 1 })
  })

  test("waits for delayed probe visible-set release", async () => {
    let now = 0
    const result = await reconcileProbeBoxesReleased([source], 1, releaseSnapshots([{ visibleIds: [source], activeBoxes: 1 }, { visibleIds: [], activeBoxes: 1 }]), { ...releaseOptions(), now: () => now, sleep: async () => { now++ } })
    expect(result).toEqual({ visibleSetReleased: true, activeCountReleased: true, activeBoxes: 1 })
  })

  test("waits for delayed probe active-count release", async () => {
    let now = 0
    const result = await reconcileProbeBoxesReleased([source], 1, releaseSnapshots([{ visibleIds: [], activeBoxes: 2 }, { visibleIds: [], activeBoxes: 1 }]), { ...releaseOptions(), now: () => now, sleep: async () => { now++ } })
    expect(result).toEqual({ visibleSetReleased: true, activeCountReleased: true, activeBoxes: 1 })
  })

  test("reports sanitized probe release timeout conditions", async () => {
    const secret = "box-secret-value", privateId = "bx_private1", url = "https://private.test/token"
    let now = 0
    let error: unknown
    try { await reconcileProbeBoxesReleased([privateId], 1, releaseSnapshots([{ visibleIds: [privateId], activeBoxes: 2 }, { visibleIds: [privateId], activeBoxes: 2 }]), { ...releaseOptions(), pollTimeoutMs: 1, now: () => now, sleep: async () => { now++ } }) } catch (caught) { error = caught }
    expect(String(error)).toContain("visible-set release, active-count release")
    for (const value of [secret, privateId, url]) expect(String(error)).not.toContain(value)
  })

  test("runs the full raw-fetch flow with exact replay, sanitized observations, and fresh signals", async () => {
    const requests: Request[] = []
    let creates = 0; let snapshotGets = 0; let sourceGets = 0; let cleanupLimits = 0; let cleanupLists = 0
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url); const body = request.body ? await request.clone().json() as any : undefined
      if (url.pathname.endsWith("/limits")) return ++cleanupLimits === 1 ? limits() : json({ ok: true, type: "limits.info", canStart: true, activeBoxes: cleanupLimits === 2 ? 1 : 0, maxActiveBoxes: 2 })
      if (url.pathname.endsWith("/account/data-retention")) return retention()
      if (url.pathname.endsWith("/boxes") && request.method === "POST") { creates++; const id = creates <= 2 ? source : restored; const state = creates === 2 ? "ready" : "provisioning"; return json({ ok: true, type: "box.created", status: state, box: { id, state } }, 202) }
      if (url.pathname.endsWith("/boxes") && request.method === "GET") return json({ ok: true, type: "box.list", boxes: ++cleanupLists === 1 ? [{ id: restored, state: "ready" }] : [] })
      if (url.pathname.endsWith(`/boxes/${source}`) && request.method === "GET") { sourceGets++; return json({ ok: true, type: "box.info", box: { id: source, state: sourceGets === 2 ? "archived" : "ready" } }) }
      if (url.pathname.endsWith(`/boxes/${restored}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: restored, state: "ready" } })
      if (url.pathname.endsWith("/files")) return json({ ok: true, type: "file.written", success: true, path: "waterbox-capability-probe-marker", encoding: "base64", size: 32 })
      if (url.pathname.endsWith("/commands")) return json({ ok: true, type: "command.finished", success: true, exitCode: 0, timedOut: false })
      if (url.pathname.endsWith("/named-snapshots") && request.method === "POST") return json({ ok: true, type: "snapshot.named.saving", snapshot: { name: body.name, sourceBoxId: source, status: "saving" } }, 202)
      if (url.pathname.includes("/named-snapshots/") && request.method === "GET") { snapshotGets++; const name = decodeURIComponent(url.pathname.split("/").at(-1)!); return json({ ok: true, type: "snapshot.named.info", snapshot: { name, sourceBoxId: source, status: snapshotGets === 1 ? "saving" : "ready", ...(snapshotGets > 1 ? { snapshotId: "artifact-1" } : {}) } }) }
      if (url.pathname.endsWith("/stop")) return json({ ok: true, type: "box.stopping", id: source, status: "archiving" }, 202)
      if (url.pathname.endsWith("/resume")) return json({ ok: true, type: "box.resuming", id: source, status: "resuming" }, 202)
      if (request.method === "DELETE" && url.pathname.includes("/boxes/")) { const id = url.pathname.split("/").at(-1)!; return json({ ok: true, type: "box.deleting", operation: { id: operation, kind: "box", targetId: id, status: "pending" } }, 202) }
      if (url.pathname.includes("/deletion-operations/")) { const deletion = [...requests].reverse().find(item => item.method === "DELETE" && new URL(item.url).pathname.includes("/boxes/"))!; const id = new URL(deletion.url).pathname.split("/").at(-1)!; return json({ ok: true, type: "deletion.operation", operation: { id: operation, kind: "box", targetId: id, status: id === restored ? "blocked" : "completed" } }) }
      if (request.method === "DELETE" && url.pathname.includes("/named-snapshots/")) { const name = decodeURIComponent(url.pathname.split("/").at(-1)!); return json({ ok: true, type: "snapshot.named.deleted", name, status: "deleted" }) }
      throw new Error(`unexpected ${request.method} ${url.pathname}`)
    }
    const logs: Array<Record<string, string | number | boolean>> = []
    const observations = await runBoxCapabilityProbe(config, { fetch: fakeFetch, sleep: async (_ms, signal) => signal.throwIfAborted(), randomId: () => "01234567-89ab-cdef", log: value => logs.push({ ...value }) })
    const createRequests = requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/boxes"))
    expect(await createRequests[0]!.clone().text()).toBe(await createRequests[1]!.clone().text())
    expect(createRequests[0]!.headers.get("idempotency-key")).toBe(createRequests[1]!.headers.get("idempotency-key"))
    const createBodies = await Promise.all(createRequests.map(request => request.clone().json() as Promise<Record<string, unknown>>))
    expect(createBodies.slice(0, 2)).toEqual([{ noEnv: true, ttlSeconds: 300 }, { noEnv: true, ttlSeconds: 300 }])
    expect(createBodies[2]).toEqual({ from: "waterbox-probe-0123456789abcdef", noEnv: true, ttlSeconds: 300 })
    expect(createBodies.every(body => !("env" in body))).toBe(true)
    expect(requests.filter(request => new URL(request.url).pathname.endsWith("/commands"))).toHaveLength(2)
    expect(requests.filter(request => request.method === "DELETE" && new URL(request.url).pathname.includes("/boxes/"))).toHaveLength(2)
    expect(new Set(requests.map(request => request.signal)).size).toBeGreaterThan(5)
    expect(requests.some(request => request.method === "GET" && new URL(request.url).pathname.endsWith("/boxes"))).toBe(true)
    expect(observations.at(-1)).toEqual({ stage: "cleanup", boxesReleased: 2, boxDeletionStatus: "accepted_pending", visibleSetReleased: true, activeCountReleased: true, snapshotDeleted: true })
    const serialized = JSON.stringify(logs)
    for (const secret of [config.apiKey, source, restored, "artifact-1", "0123456789abcdef"]) expect(serialized).not.toContain(secret)
  })

  test("uses bounded best-effort cleanup after failure and redacts credentials and resource identities", async () => {
    const requests: Request[] = []
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url)
      if (url.pathname.endsWith("/limits")) return limits()
      if (url.pathname.endsWith("/account/data-retention")) return retention()
      if (url.pathname.endsWith("/boxes") && request.method === "POST") return json({ ok: true, type: "box.created", status: "provisioning", box: { id: source, state: "ready" } }, 202)
      if (url.pathname.endsWith(`/boxes/${source}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: source, state: "ready" } })
      if (url.pathname.endsWith("/files")) return new Response(`failed ${config.apiKey} https://protected.test/token ${source}`, { status: 500 })
      if (request.method === "DELETE" && url.pathname.endsWith(source)) return json({ ok: true, type: "box.deleting", operation: { id: operation, kind: "box", targetId: source, status: "pending" } }, 202)
      if (url.pathname.includes("/deletion-operations/")) return json({ ok: true, type: "deletion.operation", operation: { id: operation, kind: "box", targetId: source, status: "completed" } })
      throw new Error("unexpected cleanup request")
    }
    let error: unknown
    try { await runBoxCapabilityProbe(config, { fetch: fakeFetch, sleep: async () => {}, randomId: () => "01234567-89ab-cdef", log: () => {} }) } catch (caught) { error = caught }
    expect(String(error)).not.toContain(config.apiKey)
    expect(String(error)).not.toContain(source)
    expect(String(error)).not.toContain("protected.test")
    expect(requests.some(request => request.method === "DELETE" && request.headers.get("x-ascii-confirm-delete") === source)).toBe(true)
    const signals = requests.map(request => request.signal)
    expect(new Set(signals).size).toBeGreaterThan(2)
  })

  test("exactly replays a lost source create response and recovers its identity for cleanup", async () => {
    const requests: Request[] = []; let creates = 0
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url)
      if (url.pathname.endsWith("/limits")) return limits()
      if (url.pathname.endsWith("/account/data-retention")) return retention()
      if (url.pathname.endsWith("/boxes") && request.method === "POST") { if (++creates === 1) throw new TypeError("response lost"); return json({ ok: true, type: "box.created", status: "provisioning", box: { id: source, state: "ready" } }, 202) }
      if (url.pathname.endsWith(`/boxes/${source}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: source, state: "ready" } })
      if (url.pathname.endsWith("/files")) return json({ ok: true, type: "file.written", success: true, path: "/wrong-path", encoding: "base64", size: 32 })
      if (request.method === "DELETE" && url.pathname.endsWith(source)) return json({ ok: true, type: "box.deleting", operation: { id: operation, kind: "box", targetId: source, status: "pending" } }, 202)
      if (url.pathname.includes("/deletion-operations/")) return json({ ok: true, type: "deletion.operation", operation: { id: operation, kind: "box", targetId: source, status: "completed" } })
      throw new Error(`unexpected ${request.method} ${url.pathname}`)
    }
    await expect(runBoxCapabilityProbe(config, deps(fakeFetch))).rejects.toThrow("invalid marker write response")
    const createRequests = requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/boxes"))
    expect(createRequests).toHaveLength(3)
    expect(await createRequests[0]!.clone().text()).toBe(await createRequests[1]!.clone().text())
    expect(createRequests[0]!.headers.get("idempotency-key")).toBe(createRequests[1]!.headers.get("idempotency-key"))
    expect(requests.some(request => request.method === "DELETE" && request.headers.get("x-ascii-confirm-delete") === source)).toBe(true)
    expect(new Set(requests.map(request => request.signal)).size).toBeGreaterThan(3)
  })

  test("exactly replays an ambiguous 5xx create response with the same body and key", async () => {
    const requests: Request[] = []; let creates = 0
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url)
      if (url.pathname.endsWith("/limits")) return limits()
      if (url.pathname.endsWith("/account/data-retention")) return retention()
      if (url.pathname.endsWith("/boxes") && request.method === "POST") { if (++creates === 1) return json({ code: "internal" }, 503); return json({ ok: true, type: "box.created", status: "provisioning", box: { id: source, state: "ready" } }, 202) }
      if (url.pathname.endsWith(`/boxes/${source}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: source, state: "ready" } })
      if (url.pathname.endsWith("/files")) return json({ ok: true, type: "file.written", success: true, path: "/wrong-path", encoding: "base64", size: 32 })
      if (request.method === "DELETE" && url.pathname.endsWith(source)) return json({ ok: true, type: "box.deleting", operation: { id: operation, kind: "box", targetId: source, status: "pending" } }, 202)
      if (url.pathname.includes("/deletion-operations/")) return json({ ok: true, type: "deletion.operation", operation: { id: operation, kind: "box", targetId: source, status: "completed" } })
      throw new Error(`unexpected ${request.method} ${url.pathname}`)
    }
    await expect(runBoxCapabilityProbe(config, deps(fakeFetch))).rejects.toThrow("invalid marker write response")
    const createRequests = requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/boxes"))
    expect(createRequests).toHaveLength(3)
    expect(await createRequests[0]!.clone().text()).toBe(await createRequests[1]!.clone().text())
    expect(createRequests[0]!.headers.get("idempotency-key")).toBe(createRequests[1]!.headers.get("idempotency-key"))
    expect(requests.some(request => request.method === "DELETE" && request.headers.get("x-ascii-confirm-delete") === source)).toBe(true)
  })

  test("does not replay a definite 4xx create response", async () => {
    const requests: Request[] = []
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url)
      if (url.pathname.endsWith("/limits")) return limits()
      if (url.pathname.endsWith("/account/data-retention")) return retention()
      if (url.pathname.endsWith("/boxes") && request.method === "POST") return json({ code: "invalid_request" }, 409)
      throw new Error(`unexpected ${request.method} ${url.pathname}`)
    }
    await expect(runBoxCapabilityProbe(config, deps(fakeFetch))).rejects.toThrow("Box request failed (409)")
    expect(requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/boxes"))).toHaveLength(1)
  })

  test("exactly replays a lost restored create response and cleans up both recovered Boxes", async () => {
    const requests: Request[] = []; let creates = 0; let snapshotGets = 0
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url); const body = request.body ? await request.clone().json() as any : undefined
      if (url.pathname.endsWith("/limits")) return limits()
      if (url.pathname.endsWith("/account/data-retention")) return retention()
      if (url.pathname.endsWith("/boxes") && request.method === "POST") { creates++; if (creates === 3) throw new TypeError("restored response lost"); const id = creates < 3 ? source : restored; return json({ ok: true, type: "box.created", status: "provisioning", box: { id, state: "ready" } }, 202) }
      if (url.pathname.endsWith(`/boxes/${source}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: source, state: "ready" } })
      if (url.pathname.endsWith(`/boxes/${restored}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: restored, state: "error" } })
      if (url.pathname.endsWith("/files")) return json({ ok: true, type: "file.written", success: true, path: "waterbox-capability-probe-marker", encoding: "base64", size: 32 })
      if (url.pathname.endsWith("/named-snapshots") && request.method === "POST") return json({ ok: true, type: "snapshot.named.saving", snapshot: { name: body.name, sourceBoxId: source, status: "saving" } }, 202)
      if (url.pathname.includes("/named-snapshots/") && request.method === "GET") { snapshotGets++; const name = decodeURIComponent(url.pathname.split("/").at(-1)!); return json({ ok: true, type: "snapshot.named.info", snapshot: { name, sourceBoxId: source, status: snapshotGets === 1 ? "saving" : "ready", ...(snapshotGets > 1 ? { snapshotId: "artifact-1" } : {}) } }) }
      if (request.method === "DELETE" && url.pathname.includes("/named-snapshots/")) { const name = decodeURIComponent(url.pathname.split("/").at(-1)!); return json({ ok: true, type: "snapshot.named.deleted", name, status: "deleted" }) }
      if (request.method === "DELETE" && url.pathname.includes("/boxes/")) { const id = url.pathname.split("/").at(-1)!; return json({ ok: true, type: "box.deleting", operation: { id: operation, kind: "box", targetId: id, status: "pending" } }, 202) }
      if (url.pathname.includes("/deletion-operations/")) { const deletion = [...requests].reverse().find(item => item.method === "DELETE" && new URL(item.url).pathname.includes("/boxes/"))!; const id = new URL(deletion.url).pathname.split("/").at(-1)!; return json({ ok: true, type: "deletion.operation", operation: { id: operation, kind: "box", targetId: id, status: "completed" } }) }
      throw new Error(`unexpected ${request.method} ${url.pathname}`)
    }
    await expect(runBoxCapabilityProbe(config, deps(fakeFetch))).rejects.toThrow("Box entered error state")
    const createRequests = requests.filter(request => request.method === "POST" && new URL(request.url).pathname.endsWith("/boxes"))
    expect(createRequests).toHaveLength(4)
    expect(await createRequests[2]!.clone().text()).toBe(await createRequests[3]!.clone().text())
    expect(createRequests[2]!.headers.get("idempotency-key")).toBe(createRequests[3]!.headers.get("idempotency-key"))
    expect(requests.filter(request => request.method === "DELETE" && new URL(request.url).pathname.includes("/boxes/"))).toHaveLength(2)
    expect(requests.some(request => request.method === "DELETE" && new URL(request.url).pathname.includes("/named-snapshots/"))).toBe(true)
  })

  test("records snapshot cleanup intent before a lost POST response", async () => {
    const requests: Request[] = []; let creates = 0
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init); requests.push(request.clone()); const url = new URL(request.url); const body = request.body ? await request.clone().json() as any : undefined
      if (url.pathname.endsWith("/limits")) return limits()
      if (url.pathname.endsWith("/account/data-retention")) return retention()
      if (url.pathname.endsWith("/boxes") && request.method === "POST") { creates++; return json({ ok: true, type: "box.created", status: "provisioning", box: { id: source, state: "ready" } }, 202) }
      if (url.pathname.endsWith(`/boxes/${source}`) && request.method === "GET") return json({ ok: true, type: "box.info", box: { id: source, state: "ready" } })
      if (url.pathname.endsWith("/files")) return json({ ok: true, type: "file.written", success: true, path: "waterbox-capability-probe-marker", encoding: "base64", size: 32 })
      if (url.pathname.endsWith("/named-snapshots") && request.method === "POST") throw new TypeError("snapshot response lost")
      if (request.method === "DELETE" && url.pathname.includes("/named-snapshots/")) { const name = decodeURIComponent(url.pathname.split("/").at(-1)!); return json({ ok: true, type: "snapshot.named.deleted", name, status: "deleted" }) }
      if (request.method === "DELETE" && url.pathname.endsWith(source)) return json({ ok: true, type: "box.deleting", operation: { id: operation, kind: "box", targetId: source, status: "pending" } }, 202)
      if (url.pathname.includes("/deletion-operations/")) return json({ ok: true, type: "deletion.operation", operation: { id: operation, kind: "box", targetId: source, status: "completed" } })
      throw new Error(`unexpected ${request.method} ${url.pathname}`)
    }
    await expect(runBoxCapabilityProbe(config, deps(fakeFetch))).rejects.toThrow("snapshot response lost")
    expect(requests.some(request => request.method === "DELETE" && new URL(request.url).pathname.includes("/named-snapshots/"))).toBe(true)
  })

  test("rejects oversized and invalid UTF-8 JSON responses through the bounded reader", async () => {
    for (const body of [new Uint8Array(1_048_577), new Uint8Array([0xff])]) {
      const response = new Response(body, { headers: { "content-type": "application/json" } })
      await expect(runBoxCapabilityProbe(config, deps(async () => response))).rejects.toThrow()
    }
  })
})

function json(value: unknown, status = 200): Response { return Response.json(value, { status }) }
function limits(): Response { return json({ ok: true, type: "limits.info", canStart: true, activeBoxes: 0, maxActiveBoxes: 2, billingStatus: "active" }) }
function retention(): Response { return json({ ok: true, type: "data_retention.info", enabled: false, enabledAt: null }) }
function deps(fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) { return { fetch: fetcher, sleep: async (_ms: number, signal: AbortSignal) => signal.throwIfAborted(), randomId: () => "01234567-89ab-cdef", log: () => {} } }
function releaseOptions() { return { pollIntervalMs: 1, pollTimeoutMs: 3, sleep: async () => {}, now: () => 0 } }
function releaseSnapshots(snapshots: Array<{ visibleIds: string[]; activeBoxes: number }>) {
  let index = 0
  return async () => snapshots[index++] ?? snapshots.at(-1)!
}
