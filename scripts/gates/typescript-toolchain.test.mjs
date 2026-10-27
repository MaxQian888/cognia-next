import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(join(root, "package.json"))
const manifest = (directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))

test("native CLI and compatibility API remain separate", () => {
  const dependencies = manifest(root).devDependencies
  assert.match(dependencies["@typescript/native"], /^npm:typescript@7\./)
  assert.match(dependencies.typescript, /^npm:@typescript\/typescript6@6\./)
  assert.match(require("@typescript/native/package.json").version, /^7\./)
  assert.match(require("typescript").version, /^6\./)
  const sdkRequire = createRequire(join(root, "packages/plugin-sdk/scripts/build-package.mjs"))
  assert.match(sdkRequire("typescript").version, /^6\./)
  assert.equal(typeof sdkRequire("typescript").createProgram, "function")
  assert.match(
    execFileSync(join(root, "node_modules/.bin/tsc"), ["--version"], { encoding: "utf8" }),
    /^Version 7\./
  )
})

test("editor selects the native SDK instead of the compatibility API", () => {
  const settings = JSON.parse(readFileSync(join(root, ".vscode/settings.json"), "utf8"))
  assert.equal(settings["js/ts.experimental.useTsgo"], true)
  const sdk = resolve(root, settings["js/ts.tsdk.path"])
  assert.match(manifest(sdk).version, /^7\./)
})

test("contract typechecks resolve canonical source without declaration build artifacts", () => {
  const ts = require("typescript")
  const directory = join(root, "packages/plugin-contract")
  const config = ts.readConfigFile(join(directory, "tsconfig.json"), ts.sys.readFile)
  assert.equal(config.error, undefined)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory)
  const host = {
    ...ts.sys,
    fileExists: (file) => !file.includes("/dist/") && ts.sys.fileExists(file),
  }
  for (const [specifier, source] of [
    ["@cognia/plugin-contract/types/a2ui/schema", "plugin-contract/src/types/a2ui/schema.ts"],
    ["@cognia/plugin-contract/contracts/generated", "plugin-contract/src/contracts/generated.ts"],
    ["@cognia/agent-pi/auth", "agent-pi/src/auth.ts"],
    ["@cognia/logging/types", "logging/src/types/index.ts"],
  ]) {
    const resolved = ts.resolveModuleName(
      specifier,
      join(directory, "src/types/plugin/plugin.ts"),
      parsed.options,
      host
    ).resolvedModule
    assert.equal(resolved?.resolvedFileName, join(root, "packages", source), specifier)
  }
})

test("workspace and sidecar scripts resolve native tsc instead of a shadowing TS6 binary", () => {
  const workspaces = [
    root,
    ...["docs", "web", "mobile", "cli", "services/workspace-runtime"].map((path) =>
      join(root, path)
    ),
    ...readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, "packages", entry.name)),
  ].filter((directory) => existsSync(join(directory, "package.json")))
  for (const directory of workspaces) {
    if (existsSync(join(directory, "tsconfig.json"))) {
      assert.ok(
        manifest(directory).scripts?.typecheck,
        `${directory} must expose a typecheck script`
      )
    }
  }
  const directories = [
    ...workspaces,
    ...["sidecar/vscode-ext-host", "sidecar/webclone"].map((path) => join(root, path)),
  ].filter((directory) => existsSync(join(directory, "package.json")))
  const checked = new Map()
  for (const directory of directories) {
    const pkg = manifest(directory)
    if (
      !pkg.scripts?.typecheck &&
      !Object.values(pkg.scripts ?? {}).some((command) => /\btsc\b/.test(command))
    )
      continue
    let current = directory
    let binary
    while (current.startsWith(root)) {
      const candidate = join(current, "node_modules/.bin/tsc")
      if (existsSync(candidate)) {
        binary = candidate
        break
      }
      current = dirname(current)
    }
    assert.ok(binary, `${pkg.name} must resolve a local tsc`)
    if (!checked.has(binary)) {
      checked.set(binary, execFileSync(binary, ["--version"], { encoding: "utf8" }))
    }
    assert.match(checked.get(binary), /^Version 7\./, `${pkg.name} must use TS7`)
  }
})

test("Next projects resolve the intended compiler and parse their config", async () => {
  const { getTypeScriptPackageInfo } = require("next/dist/lib/typescript/runTypeScriptCli.js")
  const { default: loadJsConfig } = require("next/dist/build/load-jsconfig.js")
  for (const workspace of ["docs", "web"]) {
    const directory = join(root, workspace)
    const { default: config } = await import(join(directory, "next.config.ts"))
    assert.equal(config.experimental.useTypeScriptCli, true)
    const compiler = getTypeScriptPackageInfo(directory)
    assert.match(compiler.version, /^7\./)
    assert.ok(compiler.tscPath)
    const loaded = await loadJsConfig(directory, {
      ...config,
      typescript: { tsconfigPath: "tsconfig.json" },
    })
    assert.equal(loaded.useTypeScript, true)
    assert.ok(loaded.jsConfig.compilerOptions.paths)
  }
  const compiler = getTypeScriptPackageInfo(root)
  assert.match(compiler.version, /^6\./)
  assert.ok(compiler.apiPath, "root Next/Jest config parsing retains the legacy API")
  const loaded = await loadJsConfig(root, {
    experimental: { useTypeScriptCli: false },
    typescript: { tsconfigPath: "tsconfig.json" },
  })
  assert.equal(loaded.useTypeScript, true)
})

test("legacy AST, transpilation and ts-node tools keep working", () => {
  const ts = require("typescript")
  const source = "export const answer: number = 42"
  const parsed = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true)
  assert.equal(parsed.parseDiagnostics.length, 0)
  assert.equal(parsed.statements[0].declarationList.declarations[0].name.text, "answer")
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  })
  assert.deepEqual(output.diagnostics, [])
  assert.match(output.outputText, /exports\.answer = 42/)
  const service = require("ts-node").create({
    skipProject: true,
    transpileOnly: true,
    compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
  })
  assert.match(service.ts.version, /^6\./)
  assert.match(service.compile(source, join(root, "probe.ts")), /exports\.answer = 42/)
})

test("CI caches the native compiler's separate incremental state", () => {
  const { parse } = require("yaml")
  const workflow = parse(readFileSync(join(root, ".github/workflows/quality.yml"), "utf8"))
  const cache = workflow.jobs.gates.steps.find(
    (step) => step.name === "Cache TypeScript incremental state"
  )
  const buildInfo = manifest(root).scripts.typecheck.match(/--tsBuildInfoFile\s+(\S+)/)?.[1]
  assert.ok(buildInfo, "native typecheck must keep its buildinfo separate from legacy tools")
  assert.ok(cache.with.path.split(/\s+/).includes(`${dirname(buildInfo)}/`))
})

test("generated plugin and packed agent consumers select native TypeScript", () => {
  for (const template of ["cognia-plugin-template-ts", "cognia-plugin-template-glance"]) {
    const pkg = manifest(join(root, "crates", template))
    assert.match(pkg.devDependencies.typescript, /^7\./, `${template} must use native TypeScript`)
    assert.equal(pkg.devDependencies["ts-jest"], undefined)
    assert.equal(pkg.scripts.typecheck, "tsc --noEmit")
  }
  const agentPackScript = readFileSync(
    join(root, "scripts/build/pack-test-agent-package.mjs"),
    "utf8"
  )
  assert.match(agentPackScript, /typescript:\s*installed\("@typescript\/native"\)/)
})

test("agent-omp checks types with native TypeScript before running API-independent Jest", () => {
  const directory = join(root, "packages/agent-omp")
  const pkg = manifest(directory)
  assert.match(pkg.scripts.test, /^pnpm (?:run )?typecheck && jest\b/)
  assert.equal(pkg.devDependencies["@swc/jest"], "^0.2.39")
  const config = require(join(directory, "jest.config.cjs"))
  assert.equal(config.transform["^.+\\.tsx?$"][0], "@swc/jest")
  assert.equal(manifest(root).devDependencies["ts-jest"], undefined)
})
