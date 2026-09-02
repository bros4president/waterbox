import { describe, expect, test } from "bun:test"
import { assertVercelMcpSmokeAuthorized, compareVercelBaseline, readVercelBaseline, reconcileTrackedVercelNativeLifecycle } from "./vercel-mcp-smoke.ts"

const gates = {
  WATERBOX_VERCEL_SMOKE_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_VERCEL_SANDBOX_RESOURCES",
  WATERBOX_VERCEL_SMOKE_ISOLATED_PROJECT: "YES",
  VERCEL_TOKEN: "test-token",
  VERCEL_TEAM_ID: "test-team",
  VERCEL_PROJECT_ID: "test-project",
}

describe("Vercel embedded MCP smoke", () => {
  test("requires both destructive-operation gates", () => {
    expect(() => assertVercelMcpSmokeAuthorized({})).toThrow("explicit authorization")
    expect(() => assertVercelMcpSmokeAuthorized({ WATERBOX_VERCEL_SMOKE_AUTHORIZATION: gates.WATERBOX_VERCEL_SMOKE_AUTHORIZATION })).toThrow("explicit authorization")
    expect(() => assertVercelMcpSmokeAuthorized(gates)).not.toThrow()
  })

  test("captures bounded active baselines and ignores deleted tombstones", async () => {
    const requests: Request[] = []
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init); requests.push(request)
      const path = new URL(request.url).pathname
      if (path === "/v2/sandboxes") return Response.json({ sandboxes: [{ name: "sandbox-a" }], pagination: { count: 1, next: null } })
      return Response.json({ snapshots: [{ id: "snapshot-a", status: "created" }, { id: "snapshot-deleted", status: "deleted" }], pagination: { count: 2, next: null } })
    }
    const baseline = await readVercelBaseline(gates, fetch as typeof globalThis.fetch)
    expect(baseline.sandboxes).toEqual(new Set(["sandbox-a"]))
    expect(baseline.snapshots).toEqual(new Set(["snapshot-a"]))
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      const url = new URL(request.url)
      expect(url.searchParams.get("limit")).toBe("50")
      expect(url.searchParams.get("teamId")).toBe(gates.VERCEL_TEAM_ID)
      expect(url.searchParams.get("project")).toBe(gates.VERCEL_PROJECT_ID)
      expect(request.headers.get("authorization")).toBe(`Bearer ${gates.VERCEL_TOKEN}`)
    }
  })

  test("compares exact active sets without mutating inventory", async () => {
    const baseline = { sandboxes: new Set(["sandbox-a"]), snapshots: new Set(["snapshot-a"]) }
    const methods: Array<string> = []
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(new Request(input, init).method)
      const path = new URL(String(input)).pathname
      return Response.json(path.endsWith("/snapshots") ? { snapshots: [{ id: "snapshot-a", status: "created" }], pagination: { count: 1, next: null } } : { sandboxes: [{ name: "sandbox-replacement" }], pagination: { count: 1, next: null } })
    }
    await expect(compareVercelBaseline(gates, baseline, fetch as typeof globalThis.fetch)).resolves.toEqual({ exactSandboxes: false, exactActiveSnapshots: true })
    expect(methods).toEqual(["GET", "GET"])
  })

  test("never replays an ambiguous tracked delete and accepts only exact sandbox/snapshot tombstones", async () => {
    let deletes = 0, snapshotDeletes = 0, sandboxReads = 0, snapshotReads = 0
    const adapter = {
      delete: async () => { deletes++; throw new Error("response lost after dispatch") },
      inspect: async () => { sandboxReads++; return { state: "terminated", providerRef: providerRef } },
      snapshots: {
        inspect: async () => { snapshotReads++; return { state: "deleted", providerRef: snapshotRef } },
        delete: async () => { snapshotDeletes++; throw new Error("must not mutate") },
      },
    }
    const providerRef = { kind: "vercel-sandbox-v1", name: "waterbox-smoke", owner: "owner", account: "account", automaticSnapshotId: "automatic" }
    const snapshotRef = { kind: "vercel-snapshot-v1", id: "automatic", owner: "owner", sourceName: "waterbox-smoke" }
    const ledger = { deletion: "not_started" as const }
    const result = await reconcileTrackedVercelNativeLifecycle(adapter as never, providerRef, "automatic", ledger, new AbortController().signal)
    expect(result).toEqual({ proven: true, sandboxTombstone: true, snapshotTombstone: true, manualCleanupRequired: false })
    expect(deletes).toBe(1)
    expect(sandboxReads).toBe(1)
    expect(snapshotReads).toBe(1)
    expect(snapshotDeletes).toBe(0)
    await reconcileTrackedVercelNativeLifecycle(adapter as never, providerRef, "automatic", ledger, new AbortController().signal)
    expect(deletes).toBe(1)
  })

  test("surfaces unresolved automatic-cleanup ambiguity without any mutation replay", async () => {
    let deletes = 0, snapshotDeletes = 0
    const providerRef = { kind: "vercel-sandbox-v1", name: "waterbox-smoke", owner: "owner", account: "account", automaticSnapshotId: "automatic" }
    const adapter = {
      delete: async () => { deletes++; throw new Error("automatic cleanup acknowledgement lost") },
      inspect: async () => ({ state: "running", providerRef }),
      snapshots: {
        inspect: async () => ({ state: "ready", providerRef: { kind: "vercel-snapshot-v1", id: "automatic", owner: "owner", sourceName: "waterbox-smoke" } }),
        delete: async () => { snapshotDeletes++; throw new Error("must not mutate") },
      },
    }
    const ledger = { deletion: "not_started" as const }
    const result = await reconcileTrackedVercelNativeLifecycle(adapter as never, providerRef, "automatic", ledger, new AbortController().signal)
    expect(result).toEqual({ proven: false, sandboxTombstone: false, snapshotTombstone: false, manualCleanupRequired: true })
    expect(deletes).toBe(1)
    expect(snapshotDeletes).toBe(0)
    await reconcileTrackedVercelNativeLifecycle(adapter as never, providerRef, "automatic", ledger, new AbortController().signal)
    expect(deletes).toBe(1)
    expect(snapshotDeletes).toBe(0)
  })
})
