import { describe, expect, test } from "bun:test"
import type { ToolDomain } from "@opencode-ai/plugin/promise/tool"
import type { SandboxManager } from "../src/sandbox-manager.ts"
import { registerTools } from "../src/tools.ts"

type RegisteredTool = {
  name: string
  input: Record<string, unknown>
  options: { codemode: boolean; permission: string }
}

async function registeredTools(): Promise<RegisteredTool[]> {
  const registered: RegisteredTool[] = []
  const tools = {
    async transform(callback: (draft: { add(tool: RegisteredTool): void }) => void) {
      callback({ add: (tool) => registered.push(tool) })
      return { dispose: async () => undefined }
    },
  } as unknown as ToolDomain

  await registerTools(tools, {} as SandboxManager)
  return registered
}

describe("registerTools", () => {
  test("registers remote tools with matching permissions and codemode disabled", async () => {
    const tools = await registeredTools()

    expect(tools.map(({ name }) => name)).toEqual([
      "remote_shell",
      "remote_read",
      "remote_write",
      "remote_glob",
      "remote_grep",
      "remote_edit",
      "remote_patch",
    ])
    for (const tool of tools) {
      expect(tool.options).toEqual({ codemode: false, permission: tool.name })
    }
  })

  test("uses native V2-compatible schemas for direct filesystem tools", async () => {
    const tools = new Map((await registeredTools()).map((tool) => [tool.name, tool]))

    expect(tools.get("remote_glob")?.input).toEqual(objectSchema(
      { pattern: stringSchema(true), path: stringSchema() },
      ["pattern"],
    ))
    expect(tools.get("remote_grep")?.input).toEqual(objectSchema(
      { pattern: stringSchema(true), path: stringSchema(), include: stringSchema() },
      ["pattern"],
    ))
    expect(tools.get("remote_edit")?.input).toEqual(objectSchema(
      {
        filePath: stringSchema(true),
        oldString: stringSchema(),
        newString: stringSchema(),
        replaceAll: { type: "boolean" },
      },
      ["filePath", "oldString", "newString"],
    ))
    expect(tools.get("remote_patch")?.input).toEqual(objectSchema(
      { patchText: stringSchema(true) },
      ["patchText"],
    ))
  })
})

function stringSchema(nonempty = false): Record<string, unknown> {
  return { type: "string", ...(nonempty ? { minLength: 1 } : {}) }
}

function objectSchema(
  properties: Record<string, Record<string, unknown>>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false }
}
