import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { INVENTORY_KEYS, collectInventory, workflowNodeKinds } from "./build-inventory.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

test("workflowNodeKinds counts the literal members and nothing after the array", () => {
  const source = [
    'const other = ["x", "y"]',
    "export const WORKFLOW_NODE_KINDS: readonly WorkflowNodeKind[] = [",
    '  "trigger.manual",',
    '  "trigger.cron", // "not counted"',
    '  "action.plan.create",',
    "] as const",
    'const after = ["z"]',
  ].join("\n")
  // The comment on the second line carries a quoted string, so a naive count
  // over the slice reads 4. That is the documented limit of a text scan, and
  // the real file has no quoted strings in comments inside the array.
  assert.equal(workflowNodeKinds(source), 4)
  assert.equal(workflowNodeKinds("nothing here"), 0)
})

test("collectInventory reads an empty tree as zeros rather than throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "inventory-"))
  const inventory = collectInventory(root)
  assert.deepEqual(Object.keys(inventory).sort(), [...INVENTORY_KEYS].sort())
  for (const key of INVENTORY_KEYS) assert.equal(inventory[key], 0)
})

test("collectInventory counts only directories carrying the marker file", () => {
  const root = mkdtempSync(join(tmpdir(), "inventory-"))
  mkdirSync(join(root, "plugins", "real"), { recursive: true })
  writeFileSync(join(root, "plugins", "real", "plugin.json"), "{}")
  mkdirSync(join(root, "plugins", "scratch"), { recursive: true })
  writeFileSync(join(root, "plugins", "notes.md"), "")
  mkdirSync(join(root, "lib", "connectors", "adapters", "_shared"), { recursive: true })
  mkdirSync(join(root, "lib", "connectors", "adapters", "telegram"), { recursive: true })
  mkdirSync(join(root, "docs", "content", "docs", "en", "adr"), { recursive: true })
  writeFileSync(join(root, "docs", "content", "docs", "en", "adr", "0001-a.md"), "")
  writeFileSync(join(root, "docs", "content", "docs", "en", "adr", "index.mdx"), "")

  const inventory = collectInventory(root)
  assert.equal(inventory.plugins, 1)
  assert.equal(inventory.connectors, 1)
  assert.equal(inventory.adrs, 1)
})

test("the repository itself reports a positive figure for every key", () => {
  const inventory = collectInventory(REPO_ROOT)
  for (const key of INVENTORY_KEYS) {
    assert.ok(Number.isInteger(inventory[key]) && inventory[key] > 0, `${key} should be counted`)
  }
})
