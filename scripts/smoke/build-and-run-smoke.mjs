// Bundle + run the external-parity smoke.
//
// Uses the SAME esbuild pipeline as the CLI itself (see scripts/build/dev-cli.mjs
// for why `tsx` cannot run this graph: the repo root is CommonJS while `cli/` is
// ESM, so a `export *` boundary shim breaks a from-source run).
import { spawnSync } from "node:child_process"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const kimiAcp = process.argv.includes("--kimi-acp")
const clineAcp = process.argv.includes("--cline-acp")
const qoderAcp = process.argv.includes("--qoder-acp")
const gooseAcp = process.argv.includes("--goose-acp")
const aiderCli = process.argv.includes("--aider-cli")
const devinAcp = process.argv.includes("--devin-acp")
const pi = process.argv.includes("--pi")
const dsh = process.argv.includes("--deepseek-harness") || pi || process.argv.includes("--opencode")
const entry = path.join(
  root,
  kimiAcp
    ? "scripts/smoke/kimi-acp-smoke.ts"
    : clineAcp
      ? "scripts/smoke/cline-acp-smoke.ts"
      : qoderAcp
        ? "scripts/smoke/qoder-acp-smoke.ts"
        : aiderCli
          ? "scripts/smoke/aider-cli-smoke.ts"
          : gooseAcp
            ? "scripts/smoke/goose-acp-smoke.ts"
            : dsh
              ? "scripts/smoke/deepseek-harness-adapter-smoke.ts"
              : devinAcp
                ? "scripts/smoke/devin-acp-smoke.ts"
                : "scripts/smoke/external-cognia-parity-smoke.ts"
)
const outfile = path.join(
  root,
  kimiAcp
    ? "cli/dist/smoke/kimi-acp-smoke.mjs"
    : clineAcp
      ? "cli/dist/smoke/cline-acp-smoke.mjs"
      : qoderAcp
        ? "cli/dist/smoke/qoder-acp-smoke.mjs"
        : aiderCli
          ? "cli/dist/smoke/aider-cli-smoke.mjs"
          : gooseAcp
            ? "cli/dist/smoke/goose-acp-smoke.mjs"
            : dsh
              ? "cli/dist/smoke/deepseek-harness-adapter-smoke.mjs"
              : devinAcp
                ? "cli/dist/smoke/devin-acp-smoke.mjs"
                : "cli/dist/smoke/external-cognia-parity-smoke.mjs"
)

const esbuild = await import("esbuild")

// Mirrors build-cli.mjs: the CLI graph incidentally reaches Next-only modules
// that must merely RESOLVE, never execute.
const STUB_PATTERN = /^(next\/|server-only$|client-only$)/
const stubNextPlugin = {
  name: "stub-next-runtime",
  setup(build) {
    build.onResolve({ filter: STUB_PATTERN }, (args) => ({
      path: args.path,
      namespace: "smoke-stub",
    }))
    build.onLoad({ filter: /.*/, namespace: "smoke-stub" }, () => ({
      contents:
        "const noop = () => null; module.exports = new Proxy(noop, { get: (_t, p) => (p === '__esModule' ? false : noop), apply: () => noop });",
      loader: "js",
    }))
  },
}

const jsonDefaultOnlyPlugin = {
  name: "json-default-only-messages",
  setup(build) {
    build.onLoad({ filter: /i18n[\\/]messages[\\/][^\\/]+\.json$/ }, async (args) => {
      const raw = await fs.promises.readFile(args.path, "utf8")
      return { contents: `export default ${raw}`, loader: "js" }
    })
  },
}

// Every smoke runs over the CLI's external-agent host, installed exactly the
// way cli/src/cli/entry.ts installs it, before the smoke module is evaluated.
const smokeEntry = {
  contents: [
    `import { installCliExternalAgentHost } from ${JSON.stringify(path.join(root, "cli/src/runtime/external/host-branch.ts"))}`,
    "installCliExternalAgentHost()",
    `await import(${JSON.stringify(entry)})`,
  ].join("\n"),
  resolveDir: root,
  sourcefile: `${path.basename(entry, ".ts")}-entry.mjs`,
  loader: "js",
}

fs.mkdirSync(path.dirname(outfile), { recursive: true })
await esbuild.build({
  stdin: smokeEntry,
  outfile,
  bundle: true,
  banner: { js: "globalThis.__COGNIA_CLI__ = true;" },
  platform: "node",
  format: "esm",
  target: "node26",
  tsconfig: path.join(root, "tsconfig.json"),
  packages: "external",
  loader: {
    ".ttf": "empty",
    ".css": "empty",
    ".svg": "empty",
    ".woff": "empty",
    ".woff2": "empty",
  },
  plugins: [stubNextPlugin, jsonDefaultOnlyPlugin],
  logLevel: "warning",
})

const smokeArgs = process.argv.slice(2).filter((arg) => arg !== "--deepseek-harness")
if (smokeArgs.includes("--build-only")) {
  process.stdout.write(`built ${path.relative(root, outfile)}\n`)
  process.exit(0)
}

const run = spawnSync(process.execPath, [outfile, ...smokeArgs], { stdio: "inherit" })
process.exit(run.status ?? 1)
