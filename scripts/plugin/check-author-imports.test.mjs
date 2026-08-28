import { test } from "node:test"
import assert from "node:assert/strict"

import {
  checkAuthorImports,
  checkPluginGovernance,
  findForbiddenAuthorImports,
  readGovernanceBaseline,
} from "./check-author-imports.mjs"

test("detects host-private author imports without flagging public SDK subpaths", () => {
  assert.deepEqual(
    findForbiddenAuthorImports(`
      import type { PluginContext } from "@/types/plugin"
      const host = await import("@cognia/plugin-sdk/host")
      import "@/lib/plugin/private-side-effect"
      import Widget from "@/components/private"
      const store = require("@/stores/private")
      import { useThing } from "@/hooks/private"
      import sibling from "@/plugins/other-plugin/src/internals"
      import { definePlugin } from "@cognia/plugin-sdk/manifest"
      import { Button } from "@cognia/plugin-ui"
    `),
    [
      "@/types/plugin",
      "@cognia/plugin-sdk/host",
      "@/lib/plugin/private-side-effect",
      "@/components/private",
      "@/stores/private",
      "@/hooks/private",
      "@/plugins/other-plugin/src/internals",
    ]
  )
})

test("refuses host-internal @cognia packages, admits the author-facing ones", () => {
  // An allowlist, so a package added to the workspace next month is refused by
  // default rather than quietly becoming part of the author surface.
  assert.deepEqual(
    findForbiddenAuthorImports(`
      import { hasNoLeakingPii } from "@cognia/redact"
      import { searchWithSettings } from "@cognia/web-search/types"
      import type { AppSettings } from "@cognia/agent-config-types"
      import { definePlugin } from "@cognia/plugin-sdk"
      import { Button } from "@cognia/plugin-ui/button"
    `),
    ["@cognia/redact", "@cognia/web-search/types", "@cognia/agent-config-types"]
  )
})

test("the reference in-tree plugin compiles against the SDK alone", () => {
  // Deep Research is a real, non-trivial plugin. Gating it is what proves the
  // boundary survives something bigger than a template.
  assert.deepEqual(checkAuthorImports(process.cwd(), ["plugins/deep-research"]), [])
})

test("repository author templates pass the private-import gate", () => {
  assert.deepEqual(checkAuthorImports(), [])
})

test("in-tree plugins are governed by a baseline that may only shrink", () => {
  const { violations, stale, unlisted } = checkPluginGovernance(process.cwd())

  // A plugin that is NOT on the baseline must be clean.
  assert.deepEqual(violations, [])
  // A plugin that IS on the baseline but has been cleaned must be removed from
  // it — otherwise the list overstates how much work is left, forever.
  assert.deepEqual(stale, [])
  // A baseline entry for a plugin that no longer exists is dead weight.
  assert.deepEqual(unlisted, [])
})

test("the baseline is a shrinking record, never a growing one", () => {
  const baseline = readGovernanceBaseline(process.cwd())
  assert.ok(Array.isArray(baseline))
  // Sorted + unique, so a rewrite produces a reviewable diff rather than a
  // reordered blob.
  assert.deepEqual(baseline, [...new Set(baseline)].sort())
})
