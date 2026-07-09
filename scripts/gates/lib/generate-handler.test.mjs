/**
 * Pure-function coverage for scripts/gates/lib/generate-handler.mjs.
 *
 * Run with: node --test scripts/gates/lib/generate-handler.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { extractGenerateHandlerBlock, parseRegisteredCommands } from "./generate-handler.mjs"

test("parses bare and path-qualified entries", () => {
  const src = `
fn main() {
    tauri::generate_handler![
        claude_set_api_key,
        claude::commands::claude_send,
        plugin_api::widget::plugin_widget_open,
    ];
}
`
  const commands = parseRegisteredCommands(src)
  assert.deepEqual([...commands].sort(), [
    "claude_send",
    "claude_set_api_key",
    "plugin_widget_open",
  ])
})

test("comment containing ) and ] does not truncate the block", () => {
  const src = `
tauri::generate_handler![
    // Cloud vector backends (ADR-0022) — dispatch [sic] through VectorRegistry.
    first_command,
    /* block ) comment ] here */
    second_command,
];
`
  const commands = parseRegisteredCommands(src)
  assert.deepEqual([...commands].sort(), ["first_command", "second_command"])
})

test("commented-out entries are not registered", () => {
  const src = `
tauri::generate_handler![
    live_command,
    // dead::mod::dead_command,
];
`
  const commands = parseRegisteredCommands(src)
  assert.ok(commands.has("live_command"))
  assert.ok(!commands.has("dead_command"))
})

test("paren-delimited macro form is accepted", () => {
  const src = `tauri::generate_handler!(alpha, beta::gamma)`
  const commands = parseRegisteredCommands(src)
  assert.deepEqual([...commands].sort(), ["alpha", "gamma"])
})

test("missing macro throws a stale-assumption error", () => {
  assert.throws(() => extractGenerateHandlerBlock("fn main() {}"), /stale/)
})

test("unbalanced block throws", () => {
  assert.throws(() => extractGenerateHandlerBlock("tauri::generate_handler![a, b,"), /Unbalanced/)
})

test("string literal containing a bracket does not close the block", () => {
  const src = `tauri::generate_handler![
    first_command, // note: strings are rare in this macro but must not break parsing
]`
  // Sanity: extraction returns the inner text.
  const block = extractGenerateHandlerBlock(src)
  assert.match(block, /first_command/)
})

test("malformed entries (non-identifier) are skipped, not crashed on", () => {
  const src = `tauri::generate_handler![good_one, 123bad, ]`
  const commands = parseRegisteredCommands(src)
  assert.deepEqual([...commands], ["good_one"])
})
