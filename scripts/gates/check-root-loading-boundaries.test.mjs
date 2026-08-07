import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import {
  extractStaticImports,
  findRootLoadingBoundaryViolations,
} from "./check-root-loading-boundaries.mjs"

test("extractStaticImports ignores type-only and dynamic imports", () => {
  assert.deepEqual(
    extractStaticImports(`
      import value from "static-package"
      import type { TypeOnly } from "type-package"
      const lazy = import("lazy-package")
    `),
    ["static-package"]
  )
})

test("reports a forbidden static import with its remediation", () => {
  const root = mkdtempSync(join(tmpdir(), "root-loading-"))
  const file = "components/root.tsx"
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), 'import { everything } from "wide-barrel"\n')
  const violations = findRootLoadingBoundaryViolations(root, [
    { file, forbidden: ["wide-barrel"], reason: "Use a leaf import." },
  ])
  assert.deepEqual(violations, [
    { file, forbidden: ["wide-barrel"], reason: "Use a leaf import.", specifier: "wide-barrel" },
  ])
})

test("the repository preserves every measured root-loading boundary", () => {
  assert.deepEqual(findRootLoadingBoundaryViolations(), [])
})
