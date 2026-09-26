import { test } from "node:test"
import assert from "node:assert/strict"

import { ALLOWED_COMMANDS, BLOCKED_COMMANDS, DANGEROUS_PATTERNS } from "./rules.ts"

test("ALLOWED and BLOCKED command sets are mutually exclusive", () => {
  for (const cmd of ALLOWED_COMMANDS) {
    assert.equal(BLOCKED_COMMANDS.has(cmd), false, `${cmd} appears on both lists`)
  }
})

test("DANGEROUS_PATTERNS catches representative strings", () => {
  assert.ok(DANGEROUS_PATTERNS.some((p) => p.test("; rm -rf /")))
  assert.ok(DANGEROUS_PATTERNS.some((p) => p.test("> /dev/sda")))
})

test("DANGEROUS_PATTERNS does not misclassify a malformed find expression", () => {
  const command =
    'find /Users/bytedance/Project/cognia-next -maxdepth 1 -type f -name "*.ts\\" -o -name \\"*.tsx" -o -name "*.json\\" -o -name \\"*.md" | sort'
  assert.equal(
    DANGEROUS_PATTERNS.some((pattern) => pattern.test(command)),
    false
  )
})
