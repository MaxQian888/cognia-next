import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { test } from "node:test"
import vm from "node:vm"
import ts from "typescript"

const require = createRequire(import.meta.url)

test("production type checking preserves the root workspace and generated-output exclusions", () => {
  const readConfig = (file) => {
    const result = ts.readConfigFile(file, ts.sys.readFile)
    assert.equal(result.error, undefined)
    return result.config
  }
  const root = readConfig("tsconfig.json")
  const build = readConfig("tsconfig.build.json")
  // `exclude` replaces the inherited array. Dropping a root exclusion pulls
  // other apps and bundled TypeScript into the mobile production program.
  for (const excluded of root.exclude) {
    assert.ok(build.exclude.includes(excluded), `Build config must exclude ${excluded}`)
  }
})

function config(env, observeSerwist = () => {}) {
  const source = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const exports = {}
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      if (name === "next-intl/plugin") return () => (value) => value
      if (name === "@serwist/next")
        return (options) => {
          observeSerwist(options)
          return (value) => value
        }
      return require(name)
    },
    process: { env: { NEXT_PUBLIC_GIT_COMMIT: "test", ...env }, cwd: () => process.cwd() },
    __dirname: process.cwd(),
  })
  return exports.default
}

test("mobile dev uses isolated output and same-origin assets for both bundlers", () => {
  const mobile = config({
    NODE_ENV: "development",
    NEXT_PUBLIC_PLATFORM: "mobile",
    COGNIA_NEXT_DIST_DIR: ".next-mobile-dev",
    TAURI_DEV_HOST: "10.0.0.1",
  })
  assert.equal(mobile.distDir, ".next-mobile-dev")
  assert.equal(mobile.assetPrefix, undefined)
  assert.equal(mobile.output, undefined)
  assert.deepEqual(Array.from(mobile.turbopack.resolveExtensions), [
    ".mobile.tsx",
    ".mobile.ts",
    ".mdx",
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".mjs",
    ".json",
  ])
  const webpack = mobile.webpack(
    { resolve: { extensions: [".tsx", ".js"] }, plugins: [] },
    { isServer: true }
  )
  assert.deepEqual(Array.from(webpack.resolve.extensions), [
    ".mobile.tsx",
    ".mobile.ts",
    ".tsx",
    ".js",
  ])
})

test("web/desktop defaults and mobile static export are preserved", () => {
  const desktop = config({ NODE_ENV: "development", TAURI_DEV_HOST: "10.0.0.1" })
  assert.equal(desktop.distDir, ".next")
  assert.equal(desktop.assetPrefix, "http://10.0.0.1:3000")
  assert.equal(desktop.turbopack.resolveExtensions, undefined)
  assert.equal(config({ NODE_ENV: "production", NEXT_PUBLIC_PLATFORM: "mobile" }).output, "export")
  assert.throws(
    () => config({ NODE_ENV: "production", COGNIA_NEXT_DIST_DIR: ".next-mobile-dev" }),
    /COGNIA_NEXT_DIST_DIR/
  )
})

test("output directory override cannot escape or overwrite project sources", () => {
  for (const value of ["../out", "/tmp/build", "app", "", ".", ".next/../../app", "C:\\build"]) {
    assert.throws(() => config({ COGNIA_NEXT_DIST_DIR: value }), /COGNIA_NEXT_DIST_DIR/)
  }
})

test("mobile production disables the service worker before export pruning", () => {
  let serwist
  config({ NODE_ENV: "production", NEXT_PUBLIC_PLATFORM: "mobile" }, (options) => {
    serwist = options
  })
  assert.equal(serwist.disable, true)
})

test("bundle analysis is opt-in and preserves the mobile webpack configuration", () => {
  for (const analyze of [undefined, "true"]) {
    const next = config({
      NODE_ENV: "production",
      NEXT_PUBLIC_PLATFORM: "mobile",
      ANALYZE: analyze,
    })
    const webpack = next.webpack(
      { resolve: { extensions: [".tsx", ".js"] }, plugins: [] },
      { isServer: true, nextRuntime: "nodejs" }
    )
    assert.equal(webpack.resolve.extensions[0], ".mobile.tsx")
    assert.equal(webpack.plugins.length, analyze === "true" ? 1 : 0)
    if (analyze === "true") {
      assert.equal(webpack.plugins[0].opts.analyzerMode, "static")
      assert.equal(webpack.plugins[0].opts.openAnalyzer, false)
    }
  }
})
