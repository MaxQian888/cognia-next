import { test } from "node:test"
import assert from "node:assert/strict"

import {
  ASK_USER_TOOL_NAME,
  EXIT_PLAN_TOOL_NAME,
  PLUGIN_TOOLS_SERVER_NAME,
  qualifiedToolName,
  splitToolName,
} from "./names.ts"

test("the shared tool and server names", () => {
  assert.equal(PLUGIN_TOOLS_SERVER_NAME, "cognia-plugin-tools")
  assert.equal(ASK_USER_TOOL_NAME, "ask_user")
  assert.equal(EXIT_PLAN_TOOL_NAME, "exit_plan_mode")
})

test("qualifiedToolName and splitToolName round-trip, keeping `__` inside the tool name", () => {
  assert.equal(
    qualifiedToolName(PLUGIN_TOOLS_SERVER_NAME, "ocr.extract"),
    "mcp__cognia-plugin-tools__ocr.extract"
  )
  assert.deepEqual(splitToolName("mcp__cognia-tools__a__b"), {
    server: "cognia-tools",
    bare: "a__b",
  })
  assert.deepEqual(splitToolName("Read"), { server: null, bare: "Read" })
})
