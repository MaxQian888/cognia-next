import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../../packages/plugin-contract/", import.meta.url))
const cacheRoot = fileURLToPath(new URL("../../.cache/plugin-contract-build/", import.meta.url))

test("contract value re-exports remain available to bundled ESM importers", (t) => {
  mkdirSync(cacheRoot, { recursive: true })
  const out = mkdtempSync(path.join(cacheRoot, "values-"))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import config from "./tsup.config.ts"
      import { build } from "tsup"
      await build({
        ...config,
        entry: {
          archive: "src/lib/packaging/signed-zip.ts",
          validation: "src/lib/plugin/core/validation.ts",
          hash: "src/lib/ocr/hash.ts",
          agent: "src/types/agent/external-agent.ts",
        },
        format: ["esm"],
        tsconfig: "tsconfig.json",
        dts: false,
        silent: true,
        outDir: ${JSON.stringify(out)},
      })
    `,
    ],
    { cwd: packageRoot, stdio: "pipe" }
  )
})

// Source-level hook tests bypass tsup, so they cannot detect a bundled copy of React.
test("built contract hooks share the consumer's React dispatcher in ESM and CJS", (t) => {
  mkdirSync(cacheRoot, { recursive: true })
  const out = mkdtempSync(path.join(cacheRoot, "react-"))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import config from "./tsup.config.ts"
      import { build } from "tsup"
      await build({
        ...config,
        entry: {
          width: "src/hooks/use-element-width.ts",
          effect: "src/hooks/use-isomorphic-layout-effect.ts",
        },
        dts: true,
        tsconfig: "tsconfig.json",
        silent: true,
        outDir: ${JSON.stringify(out)},
      })
    `,
    ],
    { cwd: packageRoot, stdio: "pipe" }
  )
  for (const name of ["width", "effect"]) {
    for (const extension of ["d.ts", "d.cts"]) {
      assert.ok(existsSync(path.join(out, `${name}.${extension}`)))
    }
  }
  writeFileSync(path.join(out, "package.json"), '{"type":"module"}\n')
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from "node:assert/strict"
      import { createRequire } from "node:module"
      import { fileURLToPath, pathToFileURL } from "node:url"
      import React from "react"
      import { renderToString } from "react-dom/server"
      const base = pathToFileURL(${JSON.stringify(`${out}/`)})
      const require = createRequire(new URL("consumer.cjs", base))
      for (const format of ["js", "cjs"]) {
        const load = async (name) => format === "cjs"
          ? require(fileURLToPath(new URL(name + ".cjs", base)))
          : import(new URL(name + ".js", base).href)
        const { useElementWidth } = await load("width")
        const { useIsomorphicLayoutEffect } = await load("effect")
        assert.equal(useIsomorphicLayoutEffect, React.useEffect, format)
        function Probe() {
          const ref = React.useRef(null)
          return React.createElement("span", null, String(useElementWidth(ref)))
        }
        assert.equal(renderToString(React.createElement(Probe)), "<span>0</span>", format)
      }
    `,
    ],
    { cwd: packageRoot, stdio: "pipe" }
  )
})
