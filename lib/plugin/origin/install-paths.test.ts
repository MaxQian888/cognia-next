/**
 * Every install path records where the plugin came from (ADR-0209).
 *
 * An install that forgets exports as embedded, which is safe but silently turns
 * a reproducible plugin into a copy of whatever is on disk. This pins the rule
 * at the only place it can be pinned without running every installer: each
 * host command that puts plugin files on disk is invoked from a known module,
 * and each of those modules records an origin (or hands the install to one
 * that does). A new command, or a new caller of an existing one, fails here
 * until it is added — with its recording — to the table below.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(__dirname, "..", "..", "..")

/**
 * Host install command → the modules allowed to invoke it, and the module that
 * records the origin for that call. A wrapper that stages for the manager
 * (`deferCommit`) is recorded by the manager method that commits it.
 */
const INSTALL_COMMANDS: Record<string, Record<string, string>> = {
  plugin_install: {
    "lib/plugin/core/manager.ts": "lib/plugin/core/manager.ts",
    "lib/plugin/package/marketplace.ts": "lib/plugin/package/marketplace.ts",
  },
  plugin_download_version: {
    "lib/plugin/package/marketplace.ts": "lib/plugin/package/marketplace.ts",
  },
  plugin_install_from_github: {
    "lib/plugin/core/manager.ts": "lib/plugin/core/manager.ts",
  },
  plugin_install_from_directory: {
    "lib/plugin/local/install-from-directory.ts": "lib/plugin/local/install-from-directory.ts",
    "lib/plugin/distribution/seed-bundled-plugins.ts":
      "lib/plugin/distribution/seed-bundled-plugins.ts",
  },
  plugin_wasm_install_from_git: {
    "lib/plugin/package/git-installer.ts": "lib/plugin/package/git-installer.ts",
  },
  plugin_wasm_install_from_url: {
    "lib/plugin/package/http-installer.ts": "lib/plugin/core/manager.ts",
  },
  plugin_wasm_install_from_file: {
    "lib/plugin/package/local-installer.ts": "lib/plugin/core/manager.ts",
  },
  plugin_install_from_files: {
    "lib/plugin/cogpack/plugin-tree.ts": "lib/plugin/cogpack/plugin-tree.ts",
  },
  plugin_vscode_install_vsix: {
    "lib/plugin/vscode-shim/install-vscode-extension.ts":
      "lib/plugin/vscode-shim/install-vscode-extension.ts",
  },
  plugin_vscode_install_vsix_from_path: {
    "lib/plugin/vscode-shim/install-vscode-extension.ts":
      "lib/plugin/vscode-shim/install-vscode-extension.ts",
  },
}

/** Paths that are not install call sites even though they mention a command name. */
const NOT_CALL_SITES = new Set([
  // Generated command catalog for the CLI client.
  "cli/src/api/generated/command-index.ts",
  // Switches on an Agent SDK message subtype that happens to share the
  // `plugin_install` spelling; it never invokes the host.
  "lib/claude/adapter.ts",
])

/** Plugin rows written without any host command at all. */
const ROW_ONLY_INSTALLS = ["components/plugins/dialogs/plugin-import-dialog.tsx"]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const files = ["lib", "components", "hooks", "stores", "cli/src"].flatMap((dir) =>
  sourceFiles(join(ROOT, dir)).map((full) => ({
    path: relative(ROOT, full),
    text: readFileSync(full, "utf8"),
  }))
)

function callers(command: string): string[] {
  const literal = `"${command}"`
  return files
    .filter((file) => !NOT_CALL_SITES.has(file.path) && file.text.includes(literal))
    .map((file) => file.path)
    .sort()
}

describe("install origin coverage", () => {
  it.each(Object.keys(INSTALL_COMMANDS))("%s is only invoked from known modules", (command) => {
    expect(callers(command)).toEqual(Object.keys(INSTALL_COMMANDS[command]).sort())
  })

  it("every module that records an origin for an install actually does", () => {
    const recorders = new Set([
      ...Object.values(INSTALL_COMMANDS).flatMap((map) => Object.values(map)),
      ...ROW_ONLY_INSTALLS,
    ])
    for (const path of recorders) {
      const file = files.find((candidate) => candidate.path === path)
      expect({ path, records: file?.text.includes("recordInstallOrigin(") }).toEqual({
        path,
        records: true,
      })
    }
  })

  it("the manager records an origin in each of its install entry points", () => {
    const manager = files.find((file) => file.path === "lib/plugin/core/manager.ts")!.text
    for (const method of [
      "async installPlugin(",
      "async installPluginFromGithub(",
      "async installWasmPluginFromLocalFile(",
      "async installWasmPluginFromUrl(",
      "async registerDiskPlugin(",
    ]) {
      const start = manager.indexOf(method)
      expect({ method, found: start >= 0 }).toEqual({ method, found: true })
      const next = manager.indexOf("\n  async ", start + method.length)
      const body = manager.slice(start, next === -1 ? undefined : next)
      expect({ method, records: body.includes("recordInstallOrigin(") }).toEqual({
        method,
        records: true,
      })
    }
  })
})
