import { expect, test } from "bun:test"
import { assertExperimentAuthorized, experimentMode, openCodeToolNames } from "./control-plane-mcp-experiment.ts"

test("extracts tool calls from OpenCode JSON output", () => {
  expect(openCodeToolNames([
    JSON.stringify({ type: "tool_use", part: { tool: "execute" } }),
    "diagnostic text",
    JSON.stringify({ type: "tool_use", part: { tool: "execute" } }),
  ].join("\n"))).toEqual(["execute", "execute"])
})

test("requires explicit isolated-account authorization", () => {
  expect(() => assertExperimentAuthorized({})).toThrow("explicit authorization")
  expect(() => assertExperimentAuthorized({ WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES" })).toThrow("explicit authorization")
  expect(() => assertExperimentAuthorized({ WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES", WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "YES" })).not.toThrow()
})

test("selects automated and interactive modes explicitly", () => {
  expect(experimentMode(["--run"])).toBe("automated")
  expect(experimentMode(["--interactive"])).toBe("interactive")
  expect(() => experimentMode([])).toThrow("--interactive")
})
