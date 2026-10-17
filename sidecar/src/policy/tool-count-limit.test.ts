import { test } from "node:test"
import assert from "node:assert/strict"

import { tighterToolLimit, toolDefinitionLimitFor, toolLimitFromError } from "./tool-count-limit.ts"

test("OpenAI-protocol families carry the documented 128-tool cap", () => {
  assert.equal(toolDefinitionLimitFor("openai"), 128)
  assert.equal(toolDefinitionLimitFor("azure"), 128)
})

test("families without a documented cap report none", () => {
  for (const protocol of ["anthropic", "google", "mistral", "cohere", "bedrock", "plugin-x"]) {
    assert.equal(toolDefinitionLimitFor(protocol), null, protocol)
  }
  assert.equal(toolDefinitionLimitFor(undefined), null)
  assert.equal(toolDefinitionLimitFor(null), null)
})

test("tighterToolLimit keeps the lower known limit", () => {
  assert.equal(tighterToolLimit(null, null), null)
  assert.equal(tighterToolLimit(128, null), 128)
  assert.equal(tighterToolLimit(null, 64), 64)
  assert.equal(tighterToolLimit(128, 64), 64)
  assert.equal(tighterToolLimit(32, 64), 32)
})

test("reads the cap out of tool-count rejections", () => {
  // The rejection the opencode free tier returned during the TUI walkthrough.
  assert.equal(
    toolLimitFromError(
      "[unsupported_request] tools must contain at most 128 function definitions."
    ),
    128
  )
  assert.equal(toolLimitFromError("Invalid 'tools': array too long. Expected at most 64 tools"), 64)
  assert.equal(toolLimitFromError("You may provide a maximum of 32 tools per request"), 32)
  assert.equal(toolLimitFromError("Requests support up to 100 functions"), 100)
  assert.equal(toolLimitFromError("Too many tools; the maximum is 96."), 96)
  assert.equal(toolLimitFromError("number of tools exceeds the limit of 50"), 50)
})

test("does not read unrelated limits as a tool cap", () => {
  assert.equal(
    toolLimitFromError("tools[3].function.name must be at most 64 characters"),
    null,
    "a name-length limit is not a tool count"
  )
  assert.equal(toolLimitFromError("This model's maximum context length is 128000 tokens"), null)
  assert.equal(toolLimitFromError("Too many tools were requested"), null, "no number")
  assert.equal(toolLimitFromError("at most 0 tools"), null, "a zero cap is not usable")
  assert.equal(toolLimitFromError(""), null)
  assert.equal(toolLimitFromError(undefined), null)
  assert.equal(toolLimitFromError({ message: "at most 5 tools" }), null)
})
