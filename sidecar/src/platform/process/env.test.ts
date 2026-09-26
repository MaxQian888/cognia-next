import test from "node:test"
import assert from "node:assert/strict"

import { ENV_ALLOWLIST, ENV_STRIP_PATTERNS, isStrippedName } from "./env.ts"

test("isStrippedName classifies the documented dangerous classes", () => {
  for (const name of [
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_ENTRYPOINT",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_ENDPOINT",
    "GEMINI_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENROUTER_API_KEY",
    "AWS_SESSION_TOKEN",
    "NO_PROXY",
    "SOME_VENDOR_SECRET",
    "GH_TOKEN",
  ]) {
    assert.equal(isStrippedName(name), true, name)
  }
  for (const name of ["PATH", "HOME", "MY_FEATURE_FLAG"]) {
    assert.equal(isStrippedName(name), false, name)
  }
})

test("no allowlisted runtime variable falls in a strip class", () => {
  for (const name of ENV_ALLOWLIST) assert.equal(isStrippedName(name), false, name)
  assert.ok(ENV_STRIP_PATTERNS.length > 0)
})
