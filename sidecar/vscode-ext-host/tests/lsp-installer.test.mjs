// Tests for the LSP binary resolution + npm install ladder. Every fs probe
// and the npm runner are injected, so no rung touches the real disk.
//
// Run via `pnpm sidecar:test` after `pnpm --filter @cognia/vscode-ext-host build`.

import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

const { createLspInstaller, managedPackageDir } = await import("../dist/lsp-installer.js")

/** Installer over a fake filesystem (a mutable Set of existing paths). */
function makeInstaller({ existing = new Set(), env = {}, platform = "linux", runNpm } = {}) {
  const calls = { runNpm: [], mkdir: [], writes: [] }
  const installer = createLspInstaller({
    existsSync: (p) => existing.has(p),
    mkdirSync: (p) => {
      calls.mkdir.push(p)
      existing.add(p)
    },
    writeFileSync: (p) => {
      calls.writes.push(p)
      existing.add(p)
    },
    rmdirSync: (p) => {
      existing.delete(p)
    },
    runNpm:
      runNpm ??
      (async (args, opts) => {
        calls.runNpm.push({ args, opts })
      }),
    env,
    platform,
    delay: async () => {},
  })
  return { installer, calls, existing }
}

test("rung 1: explicit path resolves verbatim and is never installed over", async () => {
  const abs = "/opt/custom/tsserver"
  const { installer, calls } = makeInstaller({ existing: new Set([abs]) })
  const hit = await installer.resolveBinary({ command: abs })
  assert.equal(hit.status, "installed")
  assert.equal(hit.source, "explicit")
  assert.equal(hit.resolvedPath, abs)

  const miss = await installer.resolveBinary({
    command: "/opt/gone/tsserver",
    npmPackage: "typescript-language-server",
    installDir: "/data/lsp",
    allowInstall: true,
  })
  assert.equal(miss.status, "missing")
  assert.equal(calls.runNpm.length, 0, "explicit paths must not trigger installs")
})

test("rung 2: project node_modules/.bin resolves walking up", async () => {
  // path.resolve so the fake-fs key matches the impl's resolved walk
  // (Windows prefixes a drive letter on resolve).
  const root = path.resolve("/repo")
  const bin = path.join(root, "node_modules", ".bin", "typescript-language-server")
  const { installer } = makeInstaller({ existing: new Set([bin]) })
  const hit = await installer.resolveBinary({
    command: "typescript-language-server",
    projectRoot: path.join(root, "packages", "app"),
  })
  assert.equal(hit.status, "installed")
  assert.equal(hit.source, "project")
  assert.equal(hit.resolvedPath, bin)
})

test("rung 3: managed dir resolves as 'managed'", async () => {
  const dir = managedPackageDir("/data/lsp", "vscode-langservers-extracted")
  const bin = path.join(dir, "node_modules", ".bin", "vscode-json-language-server")
  const { installer } = makeInstaller({ existing: new Set([bin]) })
  const hit = await installer.resolveBinary({
    command: "vscode-json-language-server",
    npmPackage: "vscode-langservers-extracted",
    installDir: "/data/lsp",
  })
  assert.equal(hit.status, "managed")
  assert.equal(hit.source, "managed")
  assert.equal(hit.resolvedPath, bin)
})

test("rung 4: PATH probe resolves", async () => {
  const bin = path.join("/usr/local/bin", "gopls")
  const { installer } = makeInstaller({
    existing: new Set([bin]),
    env: { PATH: ["/usr/bin", "/usr/local/bin"].join(path.delimiter) },
  })
  const hit = await installer.resolveBinary({ command: "gopls" })
  assert.equal(hit.status, "installed")
  assert.equal(hit.source, "path")
  assert.equal(hit.resolvedPath, bin)
})

test("rung 5: npm install runs and the managed bin re-resolves", async () => {
  const dir = managedPackageDir("/data/lsp", "yaml-language-server")
  const bin = path.join(dir, "node_modules", ".bin", "yaml-language-server")
  const progress = []
  const state = makeInstaller({
    runNpm: async (args, opts) => {
      state.calls.runNpm.push({ args, opts })
      state.existing.add(bin) // npm "creates" the bin
    },
  })
  const { installer, calls } = state
  const hit = await installer.resolveBinary({
    command: "yaml-language-server",
    npmPackage: "yaml-language-server",
    version: "1.15.0",
    installDir: "/data/lsp",
    allowInstall: true,
    onProgress: (p) => progress.push(p.phase),
  })
  assert.equal(hit.status, "managed")
  assert.equal(hit.resolvedPath, bin)
  assert.equal(calls.runNpm.length, 1)
  assert.deepEqual(calls.runNpm[0].args.slice(0, 2), ["install", "yaml-language-server@1.15.0"])
  assert.ok(calls.runNpm[0].args.includes("--prefix"))
  assert.deepEqual(progress, ["resolving", "installing", "done"])
})

test("rung 5 is skipped without allowInstall", async () => {
  const { installer, calls } = makeInstaller()
  const hit = await installer.resolveBinary({
    command: "yaml-language-server",
    npmPackage: "yaml-language-server",
    installDir: "/data/lsp",
  })
  assert.equal(hit.status, "missing")
  assert.equal(calls.runNpm.length, 0)
})

test("COGNIA_DISABLE_LSP_DOWNLOAD kill-switch blocks rung 5", async () => {
  const { installer, calls } = makeInstaller({ env: { COGNIA_DISABLE_LSP_DOWNLOAD: "1" } })
  const hit = await installer.resolveBinary({
    command: "yaml-language-server",
    npmPackage: "yaml-language-server",
    installDir: "/data/lsp",
    allowInstall: true,
  })
  assert.equal(hit.status, "missing")
  assert.equal(calls.runNpm.length, 0)
  assert.equal(installer.isDownloadDisabled(), true)
})

test("npm failure degrades to missing with the error captured", async () => {
  const progress = []
  const { installer } = makeInstaller({
    runNpm: async () => {
      throw new Error("npm install exited 1: ETARGET")
    },
  })
  const hit = await installer.resolveBinary({
    command: "bash-language-server",
    npmPackage: "bash-language-server",
    installDir: "/data/lsp",
    allowInstall: true,
    onProgress: (p) => progress.push(p.phase),
  })
  assert.equal(hit.status, "missing")
  assert.match(hit.error ?? "", /ETARGET/)
  assert.ok(progress.includes("error"))
})

test("install succeeding without producing the bin reports a clear error", async () => {
  const { installer } = makeInstaller({ runNpm: async () => {} })
  const hit = await installer.resolveBinary({
    command: "vscode-css-language-server",
    npmPackage: "vscode-langservers-extracted",
    installDir: "/data/lsp",
    allowInstall: true,
  })
  assert.equal(hit.status, "missing")
  assert.match(hit.error ?? "", /absent from the package bin/)
})

test("windows: .cmd shims resolve via PATHEXT candidates", async () => {
  // A relative dir keeps the PATH entry host-delimiter-safe (a drive-letter
  // path would split on ':' when this suite runs on POSIX).
  const bin = path.join("tools", "pyright-langserver.cmd")
  const { installer } = makeInstaller({
    platform: "win32",
    existing: new Set([bin]),
    env: { PATH: "tools", PATHEXT: ".EXE;.CMD" },
  })
  const hit = await installer.resolveBinary({ command: "pyright-langserver" })
  assert.equal(hit.status, "installed")
  assert.equal(hit.resolvedPath, bin)
})

test("managedPackageDir sanitizes scoped package names", () => {
  assert.equal(
    managedPackageDir("/data/lsp", "@vue/language-server"),
    path.join("/data/lsp", "node", "@vue__language-server")
  )
})

test("concurrent installs serialize through the advisory lock", async () => {
  const dir = managedPackageDir("/data/lsp", "yaml-language-server")
  const lockDir = path.join(dir, ".install-lock")
  let inFlight = 0
  let maxInFlight = 0
  const existing = new Set()
  const installer = createLspInstaller({
    existsSync: (p) => existing.has(p),
    mkdirSync: (p, opts) => {
      // Atomic-mkdir semantics for the lock dir: throw when it exists.
      if (p === lockDir && existing.has(p) && !opts?.recursive) throw new Error("EEXIST")
      existing.add(p)
    },
    writeFileSync: (p) => existing.add(p),
    rmdirSync: (p) => existing.delete(p),
    runNpm: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight -= 1
    },
    env: {},
    platform: "linux",
    delay: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  })
  await Promise.all([
    installer.installNpmServer({ npmPackage: "yaml-language-server", installDir: "/data/lsp" }),
    installer.installNpmServer({ npmPackage: "yaml-language-server", installDir: "/data/lsp" }),
  ])
  assert.equal(maxInFlight, 1, "second install must wait for the lock")
})
