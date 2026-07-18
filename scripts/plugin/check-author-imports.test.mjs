import { test } from "node:test"
import assert from "node:assert/strict"

import { checkAuthorImports, findForbiddenAuthorImports } from "./check-author-imports.mjs"

test("detects host-private author imports without flagging public SDK subpaths", () => {
  assert.deepEqual(
    findForbiddenAuthorImports(`
      import type { PluginContext } from "@/types/plugin"
      const host = await import("@cognia/plugin-sdk/host")
      import "@/lib/plugin/private-side-effect"
      import { definePlugin } from "@cognia/plugin-sdk/manifest"
    `),
    ["@/types/plugin", "@cognia/plugin-sdk/host", "@/lib/plugin/private-side-effect"]
  )
})

test("repository author templates pass the private-import gate", () => {
  assert.deepEqual(checkAuthorImports(), [])
})
