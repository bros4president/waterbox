import type { ToolContext, ToolDomain } from "@opencode-ai/plugin/promise/tool"
import {
  TOOL_PATHS,
  type BashArgs,
  type EditArgs,
  type GlobArgs,
  type GrepArgs,
  type PatchArgs,
  type ReadArgs,
  type WriteArgs,
} from "../../protocol/src/index.ts"
import { callBash, callJson } from "./receiver.ts"
import type { SandboxManager } from "./sandbox-manager.ts"

export async function registerTools(tools: ToolDomain, manager: SandboxManager): Promise<void> {
  await tools.transform((draft) => {
    draft.add({
      name: "remote_shell",
      description: "Execute a shell command in the isolated remote Linux workspace. Commands always start in /workspace.",
      input: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1 },
          timeout: { type: "integer", minimum: 1 },
          description: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: "remote_shell" },
      execute: async (input, context) =>
        result(await callBash(manager, input as BashArgs, receiverContext(context))),
    })

    draft.add({
      name: "remote_read",
      description: "Read a text file or list a directory in the isolated remote Linux workspace at /workspace.",
      input: {
        type: "object",
        properties: {
          filePath: { type: "string", minLength: 1 },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1 },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: "remote_read" },
      execute: async (input, context) =>
        result(await callJson(manager, TOOL_PATHS.read, input as ReadArgs, receiverContext(context))),
    })

    draft.add({
      name: "remote_write",
      description: "Write complete text contents to a file in the isolated remote Linux workspace at /workspace.",
      input: {
        type: "object",
        properties: {
          filePath: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
        required: ["filePath", "content"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: "remote_write" },
      execute: async (input, context) =>
        result(await callJson(manager, TOOL_PATHS.write, input as WriteArgs, receiverContext(context))),
    })

    draft.add({
      name: "remote_glob",
      description: "Find files matching a glob pattern in the isolated remote Linux workspace at /workspace.",
      input: {
        type: "object",
        properties: {
          pattern: { type: "string", minLength: 1 },
          path: { type: "string" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: "remote_glob" },
      execute: async (input, context) =>
        result(await callJson(manager, TOOL_PATHS.glob, input as GlobArgs, receiverContext(context))),
    })

    draft.add({
      name: "remote_grep",
      description: "Search file contents with a regular expression in the isolated remote Linux workspace at /workspace.",
      input: {
        type: "object",
        properties: {
          pattern: { type: "string", minLength: 1 },
          path: { type: "string" },
          include: { type: "string" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: "remote_grep" },
      execute: async (input, context) =>
        result(await callJson(manager, TOOL_PATHS.grep, input as GrepArgs, receiverContext(context))),
    })

    draft.add({
      name: "remote_edit",
      description: "Replace exact text in a file in the isolated remote Linux workspace at /workspace.",
      input: {
        type: "object",
        properties: {
          filePath: { type: "string", minLength: 1 },
          oldString: { type: "string" },
          newString: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["filePath", "oldString", "newString"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: "remote_edit" },
      execute: async (input, context) =>
        result(await callJson(manager, TOOL_PATHS.edit, input as EditArgs, receiverContext(context))),
    })

    draft.add({
      name: "remote_patch",
      description: "Apply an OpenCode patch in the isolated remote Linux workspace. patchText must start with '*** Begin Patch', end with '*** End Patch', and use '*** Add File:', '*** Update File:', or '*** Delete File:' headers; unified diff syntax is not accepted.",
      input: {
        type: "object",
        properties: {
          patchText: { type: "string", minLength: 1 },
        },
        required: ["patchText"],
        additionalProperties: false,
      },
      options: { codemode: false, permission: "remote_patch" },
      execute: async (input, context) =>
        result(await callJson(manager, TOOL_PATHS.patch, input as PatchArgs, receiverContext(context))),
    })
  })
}

function receiverContext(context: ToolContext) {
  return {
    abort: new AbortController().signal,
    output(value: string) {
      void context.progress({ output: value })
    },
  }
}

function result(value: Awaited<ReturnType<typeof callJson>>) {
  return { content: value.output, metadata: value.metadata }
}
