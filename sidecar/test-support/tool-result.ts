// Reading tool results in tests: the text of the first content block, as MCP
// `CallToolResult` and the kernel's `ToolResult` both carry it.

import assert from "node:assert/strict"

/** The text of a result's first content block; fails the test when it is not text. */
export function firstText(result: { content: readonly unknown[] }): string {
  const block = result.content[0] as { type?: unknown; text?: unknown } | undefined
  assert.equal(block?.type, "text", "expected the first content block to be text")
  assert.equal(typeof block?.text, "string")
  return block!.text as string
}

/** The first content block's text, parsed as JSON. */
export function firstJson<T = Record<string, unknown>>(result: { content: readonly unknown[] }): T {
  return JSON.parse(firstText(result)) as T
}
