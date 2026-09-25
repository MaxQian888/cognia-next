import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import ts from "typescript"

import {
  collectSidecarCogniaSpecifiers,
  linkedPackageDirs,
  resolveFromSidecar,
  runtimeCogniaSpecifiers,
  sidecarRoot,
  unshippableResolutions,
} from "./build-sidecar-linked-packages.mjs"

test("linkedPackageDirs keeps only link: dependencies, resolved against the sidecar", () => {
  const dirs = linkedPackageDirs(
    {
      dependencies: { "@cognia/redact": "link:../packages/redact", zod: "^4.0.0" },
      optionalDependencies: { "@cognia/extra": "link:../packages/extra", "node-pty": "^1.0.0" },
    },
    "/repo/sidecar"
  )
  assert.deepEqual(dirs, [
    { name: "@cognia/redact", dir: "/repo/packages/redact" },
    { name: "@cognia/extra", dir: "/repo/packages/extra" },
  ])
})

test("runtimeCogniaSpecifiers finds runtime imports and skips type-only ones", () => {
  const source = [
    'import { hasNoLeakingPiiDeep } from "@cognia/redact"',
    'import type { SendOptions } from "@cognia/agent-config-types"',
    'export type { ClaudeEvent } from "@cognia/agent-config-types"',
    'export { classify } from "@cognia/agent-config-types/claude-agent-sdk-options"',
    'import "@cognia/side-effect"',
    'const lazy = await import("@cognia/lazy")',
    "// see `@cognia/agent-config-types/agent-execution` for the contract",
    "import {",
    "  a,",
    "  b,",
    '} from "@cognia/multi-line"',
  ].join("\n")
  assert.deepEqual([...runtimeCogniaSpecifiers(source)].sort(), [
    "@cognia/agent-config-types/claude-agent-sdk-options",
    "@cognia/lazy",
    "@cognia/multi-line",
    "@cognia/redact",
    "@cognia/side-effect",
  ])
})

test("unshippableResolutions flags TypeScript targets and resolution failures", () => {
  assert.deepEqual(
    unshippableResolutions({
      "@cognia/ok": "file:///repo/packages/ok/dist/index.js",
      "@cognia/source": "file:///repo/packages/source/src/index.ts",
      "@cognia/gone": "error:ERR_MODULE_NOT_FOUND",
    }),
    [
      ["@cognia/source", "file:///repo/packages/source/src/index.ts"],
      ["@cognia/gone", "error:ERR_MODULE_NOT_FOUND"],
    ]
  )
})

test("every linked package can build, and the sidecar's runtime imports resolve to its compiled output", () => {
  const manifest = JSON.parse(readFileSync(join(sidecarRoot, "package.json"), "utf8"))
  const linked = linkedPackageDirs(manifest)
  assert.ok(linked.length > 0, "the sidecar links at least one workspace package")
  for (const { name, dir } of linked) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    assert.equal(typeof pkg.scripts?.build, "string", `${name} needs a build script for its node-condition output`)
  }

  const specifiers = collectSidecarCogniaSpecifiers()
  assert.ok(specifiers.includes("@cognia/redact"), "the PII gate import is found by the scan")
  const bad = unshippableResolutions(resolveFromSidecar(specifiers))
  assert.deepEqual(
    bad,
    [],
    "run `node scripts/build/build-sidecar-linked-packages.mjs`; if it still fails, the package lacks a `node` export condition for that subpath"
  )
})

test("the sidecar tsconfig maps exactly the linked packages to their source, for bundlers", () => {
  const manifest = JSON.parse(readFileSync(join(sidecarRoot, "package.json"), "utf8"))
  const linked = linkedPackageDirs(manifest)
  const { config, error } = ts.readConfigFile(join(sidecarRoot, "tsconfig.base.json"), ts.sys.readFile)
  assert.equal(error, undefined)
  const paths = config.compilerOptions.paths
  const mapped = new Set(Object.keys(paths).map((key) => key.replace(/\/\*$/, "")))
  assert.deepEqual([...mapped].sort(), linked.map(({ name }) => name).sort())
  for (const { name, dir } of linked) {
    const srcRel = `../packages/${dir.split("/").at(-1)}/src/`
    assert.ok(paths[name]?.[0]?.startsWith(srcRel), `${name} maps into ${srcRel}`)
    assert.ok(paths[`${name}/*`]?.[0] === `${srcRel}*`, `${name}/* maps to ${srcRel}*`)
  }
})
