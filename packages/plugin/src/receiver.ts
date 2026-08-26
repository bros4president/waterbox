import type { ToolResponse } from "../../protocol/src/index.ts"
import type { SandboxManager } from "./sandbox-manager.ts"

export type ReceiverContext = {
  abort: AbortSignal
  output(value: string): void
}

export async function callJson(
  manager: SandboxManager,
  path: string,
  body: unknown,
  context: ReceiverContext,
): Promise<ToolResponse> {
  const response = await manager.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    context.abort,
  )
  if (!response.ok) throw await receiverError(response)
  return (await response.json()) as ToolResponse
}

export async function callBash(
  manager: SandboxManager,
  body: unknown,
  context: ReceiverContext,
): Promise<ToolResponse> {
  const response = await manager.request(
    "/v1/tools/bash",
    {
      method: "POST",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    context.abort,
  )
  if (!response.ok) throw await receiverError(response)
  if (!response.body) throw new Error("Receiver returned an empty bash response")

  return parseBashNdjson(response.body, context)
}

export async function parseBashNdjson(
  stream: ReadableStream<Uint8Array>,
  context: ReceiverContext,
): Promise<ToolResponse> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let streamedOutput = ""
  let result: ToolResponse | undefined
  try {
    while (true) {
      if (context.abort.aborted) throw context.abort.reason
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split("\n")
      buffer = done ? "" : (lines.pop() ?? "")
      for (const line of lines) {
        const consumed = consumeBashEvent(line, context, result, streamedOutput)
        result = consumed.result
        streamedOutput = consumed.streamedOutput
      }
      if (done) break
    }
    if (buffer.trim()) result = consumeBashEvent(buffer, context, result, streamedOutput).result
  } finally {
    reader.releaseLock()
  }
  if (result === undefined) throw new Error("Receiver bash stream ended without a result")
  return result
}

function consumeBashEvent(
  line: string,
  context: Pick<ReceiverContext, "output">,
  current: ToolResponse | undefined,
  streamedOutput: string,
): { result: ToolResponse | undefined; streamedOutput: string } {
  if (!line.trim()) return { result: current, streamedOutput }
  let event: any
  try {
    event = JSON.parse(line)
  } catch (error) {
    throw new Error("Receiver returned invalid bash NDJSON", { cause: error })
  }

  if (event.type === "stdout" || event.type === "stderr") {
    const output = streamedOutput + String(event.data ?? "")
    context.output(output)
    return { result: current, streamedOutput: output }
  }
  if (event.type === "result") {
    const { type: _, ...toolResult } = event
    return { result: toolResult as ToolResponse, streamedOutput }
  }
  if (event.type === "error") throw new Error(event.error ?? event.message ?? "Remote bash failed")

  throw new Error(`Unknown bash stream event: ${String(event.type ?? "missing type")}`)
}

async function receiverError(response: Response): Promise<Error> {
  const detail = (await response.text()).trim()
  return new Error(
    `Receiver request failed with ${response.status}${detail ? `: ${detail}` : ""}`,
  )
}
