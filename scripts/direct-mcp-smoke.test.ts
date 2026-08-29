import { describe, expect, test } from "bun:test"
import { assertDirectSmokeAuthorized } from "./direct-mcp-smoke.ts"

describe("Direct MCP smoke", () => {
  test("requires both destructive-operation gates", () => {
    expect(() => assertDirectSmokeAuthorized({})).toThrow("explicit authorization")
    expect(() => assertDirectSmokeAuthorized({ WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES" })).toThrow("explicit authorization")
    expect(() => assertDirectSmokeAuthorized({
      WATERBOX_MCP_EXPERIMENT_AUTHORIZATION: "I_UNDERSTAND_THIS_CREATES_AND_DELETES_BOX_RESOURCES",
      WATERBOX_BOX_SMOKE_ISOLATED_ACCOUNT: "YES",
    })).not.toThrow()
  })
})
