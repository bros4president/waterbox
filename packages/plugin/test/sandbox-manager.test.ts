import { describe, expect, test } from "bun:test"
import { parseBashNdjson, type ReceiverContext } from "../src/receiver.ts"
import {
  SandboxManager,
  type ControlPlaneClient,
  type Fetch,
} from "../src/sandbox-manager.ts"

type FakeState = {
  runs: number
  tokens: number
  gets: number
}

function fakeControl(states: string[] = []): { client: ControlPlaneClient; state: FakeState } {
  const state = { runs: 0, tokens: 0, gets: 0 }
  const client: ControlPlaneClient = {
    async send(command) {
      const input = (command as { input: Record<string, unknown> }).input
      switch (command?.constructor.name) {
        case "RunMicrovmCommand":
          state.runs++
          expect(input.ingressNetworkConnectors).toEqual([
            "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:ALL_INGRESS",
          ])
          expect(input.egressNetworkConnectors).toEqual([
            "arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:INTERNET_EGRESS",
          ])
          return {
            microvmId: `vm-${state.runs}`,
            endpoint: `https://vm-${state.runs}.example.com`,
          }
        case "CreateMicrovmAuthTokenCommand":
          state.tokens++
          expect(input.allowedPorts).toEqual([{ port: 8080 }])
          return { authToken: { "X-aws-proxy-auth": `token-${state.tokens}` } }
        case "GetMicrovmCommand":
          state.gets++
          return { state: states.shift() ?? "RUNNING" }
        default:
          throw new Error(`Unexpected command ${command?.constructor.name}`)
      }
    },
  }
  return { client, state }
}

function manager(client: ControlPlaneClient, fetch: Fetch): SandboxManager {
  return new SandboxManager(
    { imageIdentifier: "image" },
    { client, fetch, readinessPollMs: 1, readinessTimeoutMs: 100 },
  )
}

describe("SandboxManager", () => {
  test("deduplicates concurrent lazy creation", async () => {
    const control = fakeControl()
    const fetch: Fetch = async () => new Response("ok")
    const subject = manager(control.client, fetch)
    const abort = new AbortController().signal

    const [first, second] = await Promise.all([
      subject.ensureSandbox(abort),
      subject.ensureSandbox(abort),
    ])

    expect(first).toBe(second)
    expect(control.state.runs).toBe(1)
    expect(control.state.tokens).toBe(1)
  })

  test("refreshes a rejected token and retries against the same VM", async () => {
    const control = fakeControl()
    let calls = 0
    const urls: string[] = []
    const fetch: Fetch = async (input) => {
      const url = String(input)
      urls.push(url)
      calls++
      if (url.endsWith("/health")) return new Response("ok")
      if (calls === 2) return new Response("forbidden", { status: 403 })
      return Response.json({ output: "contents" })
    }
    const subject = manager(control.client, fetch)

    const response = await subject.request("/v1/tools/read", { method: "POST" }, new AbortController().signal)

    expect(response.status).toBe(200)
    expect(control.state.runs).toBe(1)
    expect(control.state.tokens).toBe(2)
    expect(urls[1]).toContain("vm-1.example.com/v1/tools/read")
    expect(urls[2]).toContain("vm-1.example.com/v1/tools/read")
  })

  test("probes but does not recreate a running VM after a 502", async () => {
    const control = fakeControl(["RUNNING"])
    const fetch: Fetch = async (input) =>
      String(input).endsWith("/health")
        ? new Response("ok")
        : new Response("gateway", { status: 502 })
    const subject = manager(control.client, fetch)

    const response = await subject.request("/v1/tools/read", { method: "POST" }, new AbortController().signal)

    expect(response.status).toBe(502)
    expect(control.state.gets).toBe(1)
    expect(control.state.runs).toBe(1)
  })

  test("recreates and retries once when a 502 belongs to a terminated VM", async () => {
    const control = fakeControl(["TERMINATED"])
    let toolCalls = 0
    const fetch: Fetch = async (input) => {
      if (String(input).endsWith("/health")) return new Response("ok")
      toolCalls++
      return toolCalls === 1
        ? new Response("gateway", { status: 502 })
        : Response.json({ output: "retried" })
    }
    const subject = manager(control.client, fetch)

    const response = await subject.request("/v1/tools/read", { method: "POST" }, new AbortController().signal)

    expect(response.status).toBe(200)
    expect(control.state.runs).toBe(2)
    expect(toolCalls).toBe(2)
  })
})

test("parseBashNdjson forwards streamed output and returns the final response", async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"stdout","data":"one"}\n'))
      controller.enqueue(encoder.encode('{"type":"stderr","data":"two"}\n'))
      controller.enqueue(encoder.encode('{"type":"result","title":"Done","output":"Command exited with code 0","metadata":{"exitCode":0}}\n'))
      controller.close()
    },
  })
  const updates: unknown[] = []
  const context = {
    abort: new AbortController().signal,
    output: (update: string) => updates.push(update),
  } as ReceiverContext

  const result = await parseBashNdjson(stream, context)

  expect(updates).toEqual(["one", "onetwo"])
  expect(result).toEqual({ title: "Done", output: "Command exited with code 0", metadata: { exitCode: 0 } })
})
