/**
 * Regression coverage for scripts/check-silent-failure-flags.mjs.
 *
 * The audit script itself reads from the real repo at process scope, so we
 * exercise it as a black box: build a temp git checkout that mirrors the
 * layout the script expects, point the script at it via cwd, and assert on
 * exit code + stderr/stdout content.
 *
 * Run with: node --test scripts/check-silent-failure-flags.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, "check-silent-failure-flags.mjs")

function makeFixture({ libRs, tsFiles = [], rustSources = [], pluginsRust = [] }) {
  const root = mkdtempSync(join(tmpdir(), "silent-flag-audit-"))
  mkdirSync(join(root, "src-tauri", "src", "plugin_api"), { recursive: true })
  mkdirSync(join(root, "src-tauri", "src", "plugins"), { recursive: true })
  writeFileSync(join(root, "src-tauri", "src", "lib.rs"), libRs, "utf8")
  for (const { path, contents } of rustSources) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, "utf8")
  }
  for (const { path, contents } of pluginsRust) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, "utf8")
  }
  for (const { path, contents } of tsFiles) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, "utf8")
  }
  // Initialise git so `git ls-files` works (script uses it to enumerate TS).
  spawnSync("git", ["init", "-q"], { cwd: root })
  spawnSync("git", ["config", "user.email", "audit@test"], { cwd: root })
  spawnSync("git", ["config", "user.name", "audit"], { cwd: root })
  spawnSync("git", ["add", "."], { cwd: root })
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root })
  return root
}

function runScript(root) {
  // The script resolves REPO_ROOT relative to its own file location
  // (`__dirname/../..`), so we copy it into the fixture's scripts/gates/ subdir
  // to mirror its real two-level depth.
  const scriptDest = join(root, "scripts", "gates", "check-silent-failure-flags.mjs")
  mkdirSync(join(root, "scripts", "gates"), { recursive: true })
  spawnSync(
    "node",
    ["-e", `require('fs').copyFileSync(${JSON.stringify(SCRIPT)}, ${JSON.stringify(scriptDest)})`],
    {
      cwd: root,
    }
  )
  spawnSync("git", ["add", "scripts/gates/check-silent-failure-flags.mjs"], { cwd: root })
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "add script"], { cwd: root })
  return spawnSync("node", [scriptDest], { cwd: root, encoding: "utf8" })
}

const HANDLER_RS = `
#[tauri::command]
pub async fn plugin_widget_open(plugin_id: String) -> Result<(), String> { Ok(()) }
`

const NESTED_HANDLER_RS = `
#[tauri::command]
pub async fn plugin_widget_nested(plugin_id: String) -> Result<(), String> { Ok(()) }
`

function libRs(...registered) {
  const entries = registered.map((path) => `            ${path},`).join("\n")
  return `
fn main() {
    tauri::generate_handler![
${entries}
    ];
}
`
}

test("matched handler + correct flag exits 0", () => {
  const root = makeFixture({
    libRs: libRs("plugin_api::widget::plugin_widget_open"),
    rustSources: [{ path: "src-tauri/src/plugin_api/widget.rs", contents: HANDLER_RS }],
    tsFiles: [
      {
        path: "lib/plugin/widget.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          import { recordSilentFailure } from "./contracts/diagnostics-store"
          export async function open(pluginId: string) {
            try {
              await invoke("plugin_widget_open", { pluginId })
            } catch (error) {
              recordSilentFailure({ pluginId, point: "widget.open", error, expected: false })
            }
          }
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /OK: 1 TS files audited, 1 Rust handlers registered/)
  rmSync(root, { recursive: true, force: true })
})

test("matched handler + stale !isTauri() flag exits 1 with flip hint", () => {
  const root = makeFixture({
    libRs: libRs("plugin_api::widget::plugin_widget_open"),
    rustSources: [{ path: "src-tauri/src/plugin_api/widget.rs", contents: HANDLER_RS }],
    tsFiles: [
      {
        path: "lib/plugin/widget.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          import { recordSilentFailure } from "./contracts/diagnostics-store"
          export async function open(pluginId: string) {
            try {
              await invoke("plugin_widget_open", { pluginId })
            } catch (error) {
              recordSilentFailure({ pluginId, point: "widget.open", error, expected: !isTauri() })
            }
          }
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /flip to expected: false/)
  rmSync(root, { recursive: true, force: true })
})

test("missing handler + expected: false exits 1 with revert hint", () => {
  const root = makeFixture({
    libRs: libRs(),
    rustSources: [],
    tsFiles: [
      {
        path: "lib/plugin/widget.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          import { recordSilentFailure } from "./contracts/diagnostics-store"
          export async function open(pluginId: string) {
            try {
              await invoke("plugin_widget_open", { pluginId })
            } catch (error) {
              recordSilentFailure({ pluginId, point: "widget.open", error, expected: false })
            }
          }
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /revert to expected: !isTauri\(\)/)
  rmSync(root, { recursive: true, force: true })
})

test("missing handler + expected: !isTauri() exits 0", () => {
  const root = makeFixture({
    libRs: libRs(),
    rustSources: [],
    tsFiles: [
      {
        path: "lib/plugin/widget.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          import { recordSilentFailure } from "./contracts/diagnostics-store"
          export async function open(pluginId: string) {
            try {
              await invoke("plugin_widget_open", { pluginId })
            } catch (error) {
              recordSilentFailure({ pluginId, point: "widget.open", error, expected: !isTauri() })
            }
          }
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})

test("nested module handler (plugin_api::wasm::commands) is discovered", () => {
  const root = makeFixture({
    libRs: libRs("plugin_api::wasm::commands::plugin_widget_nested"),
    rustSources: [
      { path: "src-tauri/src/plugin_api/wasm/commands.rs", contents: NESTED_HANDLER_RS },
    ],
    tsFiles: [
      {
        path: "lib/plugin/widget.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          import { recordSilentFailure } from "./contracts/diagnostics-store"
          export async function open(pluginId: string) {
            try {
              await invoke("plugin_widget_nested", { pluginId })
            } catch (error) {
              recordSilentFailure({ pluginId, point: "widget.nested", error, expected: false })
            }
          }
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})

test("orphaned declaration (source defines but lib.rs forgets) exits 1", () => {
  const root = makeFixture({
    libRs: libRs(), // empty generate_handler!
    rustSources: [{ path: "src-tauri/src/plugin_api/widget.rs", contents: HANDLER_RS }],
    tsFiles: [],
  })
  const result = runScript(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /declared but NOT registered in generate_handler!/)
  assert.match(result.stderr, /plugin_widget_open/)
  rmSync(root, { recursive: true, force: true })
})

test("plugin-owned Rust source brought in via #[path = ...] is discovered", () => {
  const root = makeFixture({
    libRs: libRs("plugins::computer_use::commands::plugin_computer_use_execute"),
    rustSources: [
      {
        path: "src-tauri/src/plugins/computer_use/mod.rs",
        contents: `#[path = "../../../../plugins/computer-use/rust/src/commands.rs"]\npub mod commands;\n`,
      },
    ],
    pluginsRust: [
      {
        path: "plugins/computer-use/rust/src/commands.rs",
        contents: `\n#[tauri::command]\npub async fn plugin_computer_use_execute() -> Result<(), String> { Ok(()) }\n`,
      },
    ],
    tsFiles: [],
  })
  const result = runScript(root)
  // No TS invokes, just verifying declaration + registration match.
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})

test("comment with parens inside generate_handler! does not truncate the block", () => {
  const libWithComment = `
fn main() {
    tauri::generate_handler![
        // Cloud vector backends (ADR-0022) — dispatch through VectorRegistry.
        plugin_api::widget::plugin_widget_open,
    ];
}
`
  const root = makeFixture({
    libRs: libWithComment,
    rustSources: [{ path: "src-tauri/src/plugin_api/widget.rs", contents: HANDLER_RS }],
    tsFiles: [],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})
