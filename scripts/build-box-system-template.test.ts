import { describe, expect, test } from "bun:test"
import { boundedJson, createTemplateRequest, installCommand, loadTemplateConfig, parseAction, parseArtifactUpload, parseCommand, parseCreatedBox, parseMetadata, parseSnapshot, runTemplateBuild, validateCliArtifact, validateCliReports, type TemplateConfig, type TemplateDependencies } from "./build-box-system-template.ts"

const json = (value: unknown, status = 200) => Response.json(value, { status })
const artifact = () => new TextEncoder().encode('#!/usr/bin/env node\nconst root = process.env.WORKSPACE_ROOT\nconst mode = "__internal-bash-worker"\nconst executable = "/usr/local/bin/node"\nconst entry = "/usr/local/lib/waterbox-cli.js"\nconsole.log(root, mode, executable, entry)\n')
const box = (state: string) => ({ id: "bx_23456789", name: "Template source", state, desktopAvailable: false, snapshotAvailable: false })
const snapshot = (status: string) => ({ name: "waterbox-system-v6", status, sourceBoxId: "bx_23456789", createdAt: "2026-08-27T00:00:00.000Z", ...(status === "ready" ? { snapshotId: "snapshot-artifact" } : {}) })
const deletion = (status: string) => ({ id: "bdop_0123456789abcdef0123456789abcdef", kind: "box", targetId: "bx_23456789", reason: "explicit", status, attemptCount: 1, requestedAt: "2026-08-27T00:00:00.000Z", completedAt: status === "completed" ? "2026-08-27T00:01:00.000Z" : null })
const config: TemplateConfig = {
  apiBaseUrl: "https://api.box.test",
  apiKey: "box-secret-key",
  templateName: "waterbox-system-v6",
  artifactPath: "/tmp/cli",
  metadataPath: "/tmp/metadata.json",
  pollIntervalMs: 1,
  pollTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
}

describe("Box system template builder", () => {
  test("constructs a bootstrap create request with no from and no secrets", () => {
    const request = createTemplateRequest("01234567-89ab-cdef")
    expect(request).toEqual({ body: { noEnv: true, env: { WATERBOX_SANDBOX_ID: "waterbox-template-0123456789abcdef" }, ttlSeconds: 1800 }, idempotencyKey: "waterbox-template-0123456789abcdef" })
    expect(request.body).not.toHaveProperty("from")
  })

  test("constructs a fixed CLI installation with no provider credentials or service", () => {
    const command = installCommand()
    expect(command).toContain("/usr/local/lib/waterbox-cli.js")
    expect(command).toContain("/usr/local/bin/waterbox")
    expect(command).toContain("test -x /usr/local/bin/node")
    expect(command).toContain("sudo -n env WORKSPACE_ROOT=/workspace")
    expect(command).toContain("install -d -m 0700 /run/waterbox/bash-jobs")
    expect(command).toContain("/usr/local/bin/node /usr/local/lib/waterbox-cli.js")
    expect(command).not.toContain("bun")
    expect(command).toContain("cd /workspace")
    expect(command).toContain('install -d -m 0755 -o "$(id -u)" -g "$(id -g)" /workspace')
    expect(command.match(/install -d -m 0755 -o/g)).toHaveLength(2)
    expect(command).toContain('"$(waterbox health)"')
    expect(command).toContain('"$(waterbox version)"')
    expect(command).toContain('"protocolVersion":2')
    expect(command).toContain("ripgrep ca-certificates")
    expect(command).not.toContain("unzip")
    expect(command).not.toContain("flock")
    expect(command).not.toContain("waterbox-cli.lock")
    expect(command).not.toContain("util-linux")
    expect(command).not.toContain("systemctl")
    expect(command).not.toContain("BOX_API_KEY")
  })

  test("requires and correlates official response fields", () => {
    const created = { ok: true, type: "box.created", status: "provisioning", ttlSeconds: 1800, box: box("provisioning") }
    expect(parseCreatedBox(created)).toEqual({ id: "bx_23456789" })
    expect(() => parseCreatedBox({ ...created, ttlSeconds: undefined })).toThrow("invalid create")
    expect(() => parseCreatedBox({ ...created, box: { ...box("provisioning"), desktopAvailable: undefined } })).toThrow("invalid create")
    expect(() => parseAction({ ok: true, type: "box.stopping", id: "bx_23456789" }, "bx_23456789", "box.stopping")).toThrow("invalid action")
    expect(() => parseCommand({ ok: true, type: "command.finished", success: true, exitCode: 0, timedOut: false })).toThrow("invalid command response")
    expect(() => parseArtifactUpload({ ok: true, type: "file.written", success: true, path: "waterbox-cli.js", encoding: "base64", size: 64 }, 64)).toThrow("upload response")
    expect(() => parseArtifactUpload({ ok: true, type: "file.written", success: true, path: "/tmp/waterbox-cli.js", encoding: "utf8", size: 64 }, 64)).toThrow("upload response")
    expect(() => parseSnapshot({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: { ...snapshot("saving"), createdAt: undefined } }, "snapshot.named.saving", "waterbox-system-v6", "bx_23456789")).toThrow("snapshot response")
    expect(() => parseSnapshot({ ok: true, type: "snapshot.named.info", snapshot: { ...snapshot("ready"), snapshotId: undefined } }, "snapshot.named.info", "waterbox-system-v6", "bx_23456789")).toThrow("snapshot response")
  })

  test("incrementally bounds and cancels oversized provider responses", async () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(700_000)); controller.enqueue(new Uint8Array(400_000)) }, cancel() { canceled = true } })
    await expect(boundedJson(new Response(body, { headers: { "content-type": "application/json" } }))).rejects.toThrow("size limit")
    expect(canceled).toBe(true)
  })

  test("validates configuration and metadata without credentials", () => {
    const loaded = loadTemplateConfig({}, ["--validate"])
    expect(loaded.apiKey).toBe("")
    expect(loaded.templateName).toBe("waterbox-system-v6")
    expect(() => loadTemplateConfig({}, ["--run"])).toThrow("environment-authorized")
    expect(() => loadTemplateConfig({}, ["--validate", "--replace"])).toThrow("Unknown option")
    expect(() => loadTemplateConfig({ WATERBOX_BOX_TEMPLATE_NAME: "latest" }, ["--validate"])).toThrow("invalid or reserved")
    expect(parseMetadata('{"schemaVersion":2,"provider":"box","templateRef":"waterbox-system-v6","artifactKind":"waterbox-cli","cliProtocolVersion":2,"builtAt":"2026-08-27T00:00:00.000Z"}').templateRef).toBe("waterbox-system-v6")
    expect(() => parseMetadata('{"schemaVersion":2,"provider":"box","templateRef":"../secret","artifactKind":"waterbox-cli","cliProtocolVersion":2,"builtAt":"no"}')).toThrow("invalid")
    expect(() => parseMetadata('{"schemaVersion":2,"provider":"box","templateRef":"waterbox-system-v6","artifactKind":"waterbox-cli","cliProtocolVersion":1,"builtAt":"2026-08-27T00:00:00.000Z"}')).toThrow("invalid")
    expect(() => validateCliArtifact(new Uint8Array(64))).toThrow("JavaScript bundle")
    expect(() => validateCliArtifact(new TextEncoder().encode("console.log('not bundled')"))).toThrow("JavaScript bundle")
    expect(() => validateCliArtifact(artifact())).not.toThrow()
    expect(() => validateCliReports('{"ok":true,"protocolVersion":2,"tools":["read","write","edit","patch","glob","grep","bash"]}\n', '{"protocolVersion":2}\n')).not.toThrow()
    expect(() => validateCliReports('{"ok":true,"protocolVersion":1,"tools":[]}', '{"protocolVersion":1}')).toThrow("health")
  })

  test("rejects an incompatible artifact before any provider request", async () => {
    let fetches = 0
    const deps: TemplateDependencies = { fetch: async () => { fetches++; return json({}) }, sleep: async () => {}, randomId: () => "0123456789abcdef", log: () => {}, readArtifact: async () => new Uint8Array(64), writeMetadata: async () => {} }
    await expect(runTemplateBuild(config, deps)).rejects.toThrow("JavaScript bundle")
    expect(fetches).toBe(0)
  })

  test("builds, stops before snapshotting, emits non-secret metadata, and confirms cleanup", async () => {
    const seen: Array<{ method: string; path: string; body?: any; headers: Headers }> = []
    let boxGets = 0
    let snapshotGets = 0
    let metadata = ""
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input)); const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : undefined; const headers = new Headers(init?.headers)
      seen.push({ method, path: url.pathname, body, headers })
      if (url.pathname.endsWith("/named-snapshots/waterbox-system-v6") && method === "GET" && snapshotGets++ === 0) return json({ ok: false }, 404)
      if (url.pathname.endsWith("/boxes") && method === "POST") return json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 1800, box: box("provisioning") }, 202)
      if (url.pathname.endsWith("/boxes/bx_23456789") && method === "GET") return json({ ok: true, type: "box.info", box: box(boxGets++ === 0 ? "ready" : "archived") })
       if (url.pathname.endsWith("/files") && method === "PUT") return json({ ok: true, type: "file.written", success: true, size: artifact().byteLength, path: "../../tmp/waterbox-cli.js", encoding: "base64" })
      if (url.pathname.endsWith("/commands")) return json({ ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false })
      if (url.pathname.endsWith("/stop")) return json({ ok: true, type: "box.stopping", id: "bx_23456789", status: "archiving" }, 202)
      if (url.pathname.endsWith("/named-snapshots") && method === "POST") return json({ ok: true, type: "snapshot.named.saving", status: "saving", snapshot: snapshot("saving") }, 202)
      if (url.pathname.endsWith("/named-snapshots/waterbox-system-v6")) return json({ ok: true, type: "snapshot.named.info", snapshot: snapshot("ready") })
      if (url.pathname.endsWith("/boxes/bx_23456789") && method === "DELETE") return json({ ok: true, type: "box.deleting", operation: deletion("pending") }, 202)
      if (url.pathname.endsWith("/deletion-operations/bdop_0123456789abcdef0123456789abcdef")) return json({ ok: true, type: "deletion.operation", operation: deletion("completed") })
      throw new Error(`Unexpected ${method} ${url.pathname}`)
    }
    const dependencies: TemplateDependencies = { fetch: fetcher, sleep: async () => {}, randomId: () => "0123456789abcdef", log: () => {}, readArtifact: async () => artifact(), writeMetadata: async (_path, value) => { metadata = value } }
    const result = await runTemplateBuild(config, dependencies)
    expect(result.templateRef).toBe("waterbox-system-v6")
    expect(metadata).not.toContain("box-secret-key")
    const create = seen.find(value => value.path.endsWith("/boxes") && value.method === "POST")!
    expect(create.body).toEqual({ noEnv: true, env: { WATERBOX_SANDBOX_ID: "waterbox-template-0123456789abcdef" }, ttlSeconds: 1800 })
    expect(create.headers.get("idempotency-key")).toBe("waterbox-template-0123456789abcdef")
    const stopIndex = seen.findIndex(value => value.path.endsWith("/stop"))
    const saveIndex = seen.findIndex(value => value.path.endsWith("/named-snapshots") && value.method === "POST")
    expect(stopIndex).toBeLessThan(saveIndex)
    const deleteRequest = seen.find(value => value.method === "DELETE")!
    expect(deleteRequest.headers.get("x-ascii-confirm-delete")).toBe("bx_23456789")
  })

  test("refuses same-name mutation and redacts errors", async () => {
    const deps: TemplateDependencies = {
      fetch: async input => String(input).includes("named-snapshots")
        ? json({ ok: true, type: "snapshot.named.info", snapshot: { ...snapshot("ready"), sourceBoxId: "bx_abcdefgh" } })
        : json({ ok: false }, 500),
      sleep: async () => {}, randomId: () => "0123456789abcdef", log: () => {}, readArtifact: async () => artifact(), writeMetadata: async () => {},
    }
    await expect(runTemplateBuild(config, deps)).rejects.toThrow("new immutable versioned name")
    const failing = { ...deps, fetch: async () => { throw new Error(`leaked ${config.apiKey} https://protected.test/?_token=abc`) } }
    await expect(runTemplateBuild(config, failing)).rejects.not.toThrow(config.apiKey)
  })

  test("exactly replays an ambiguous bootstrap create with the same body and key", async () => {
    const creates: Array<{ body: string | undefined; key: string | null }> = []
    let createAttempt = 0
    let deletes = 0
    const deps: TemplateDependencies = {
      fetch: async (input, init) => {
        const url = new URL(String(input)); const method = init?.method ?? "GET"
        if (url.pathname.endsWith("/named-snapshots/waterbox-system-v6")) return json({ ok: false }, 404)
        if (url.pathname.endsWith("/boxes") && method === "POST") { creates.push({ body: String(init?.body), key: new Headers(init?.headers).get("idempotency-key") }); const attempt = createAttempt++; if (attempt === 0) throw new Error("lost response"); if (attempt === 1) return json({ ok: false, type: "box.error", status: 409, code: "idempotency_in_progress", message: "in progress", requestId: "req_fake", error: { code: "idempotency_in_progress", message: "in progress", status: 409 } }, 409); if (attempt === 2) return json({ ok: false, type: "box.error", status: 503, code: "http_503", message: "unavailable", requestId: "req_retry", error: { code: "http_503", message: "unavailable", status: 503 } }, 503); return json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 1800, box: box("provisioning") }, 202) }
        if (url.pathname.endsWith("/boxes/bx_23456789") && method === "GET") return json({ ok: true, type: "box.info", box: box("error") })
        if (url.pathname.endsWith("/boxes/bx_23456789") && method === "DELETE") { deletes++; return json({ ok: true, type: "box.deleting", operation: deletion("pending") }, 202) }
        if (url.pathname.endsWith("/deletion-operations/bdop_0123456789abcdef0123456789abcdef")) return json({ ok: true, type: "deletion.operation", operation: deletion("completed") })
        throw new Error(`Unexpected ${method} ${url.pathname}`)
      },
      sleep: async () => {}, randomId: () => "0123456789abcdef", log: () => {}, readArtifact: async () => artifact(), writeMetadata: async () => {},
    }
    await expect(runTemplateBuild(config, deps)).rejects.toThrow("error state")
    expect(creates).toHaveLength(4)
    expect(creates[0]).toEqual(creates[1])
    expect(creates[1]).toEqual(creates[2])
    expect(creates[2]).toEqual(creates[3])
    expect(creates.every(value => value.body === creates[0]?.body && value.key === creates[0]?.key)).toBe(true)
    expect(deletes).toBe(1)
  })

  test("cleans up the source after a definite snapshot rejection", async () => {
    let boxGets = 0, deletes = 0
    const deps: TemplateDependencies = {
      fetch: async (input, init) => {
        const url = new URL(String(input)); const method = init?.method ?? "GET"
        if (url.pathname.endsWith("/named-snapshots/waterbox-system-v6")) return json({ ok: false }, 404)
        if (url.pathname.endsWith("/boxes") && method === "POST") return json({ ok: true, type: "box.created", status: "provisioning", ttlSeconds: 1800, box: box("provisioning") }, 202)
        if (url.pathname.endsWith("/boxes/bx_23456789") && method === "GET") return json({ ok: true, type: "box.info", box: box(boxGets++ === 0 ? "ready" : "archived") })
        if (url.pathname.endsWith("/files")) return json({ ok: true, type: "file.written", success: true, size: artifact().byteLength, path: "/tmp/waterbox-cli.js", encoding: "base64" })
        if (url.pathname.endsWith("/commands")) return json({ ok: true, type: "command.finished", success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false })
        if (url.pathname.endsWith("/stop")) return json({ ok: true, type: "box.stopping", id: "bx_23456789", status: "archiving" }, 202)
        if (url.pathname.endsWith("/named-snapshots") && method === "POST") return json({ ok: false, code: "invalid_request" }, 400)
        if (url.pathname.endsWith("/boxes/bx_23456789") && method === "DELETE") { deletes++; return json({ ok: true, type: "box.deleting", operation: deletion("completed") }, 202) }
        throw new Error(`Unexpected ${method} ${url.pathname}`)
      },
      sleep: async () => {}, randomId: () => "0123456789abcdef", log: () => {}, readArtifact: async () => artifact(), writeMetadata: async () => {},
    }
    await expect(runTemplateBuild(config, deps)).rejects.toThrow("HTTP 400")
    expect(deletes).toBe(1)
  })
})
