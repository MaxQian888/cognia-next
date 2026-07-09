/**
 * Regression coverage for scripts/gates/check-command-parity.mjs.
 *
 * Black-box fixture pattern (mirrors check-silent-failure-flags.test.mjs):
 * build a temp git checkout with the layout the script expects, copy the
 * script + shared lib in, run it, and assert on exit code + output. The pure
 * scanSource() helper is additionally unit-tested via direct import.
 *
 * Run with: node --test scripts/gates/check-command-parity.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { scanSource } from "./check-command-parity.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, "check-command-parity.mjs")
const SHARED_LIB = resolve(__dirname, "lib", "generate-handler.mjs")

function libRs(...entries) {
  return `
fn main() {
    tauri::generate_handler![
${entries.map((e) => `        ${e},`).join("\n")}
    ];
}
`
}

function makeFixture({ libRs: libContents, tsFiles = [] }) {
  const root = mkdtempSync(join(tmpdir(), "command-parity-"))
  mkdirSync(join(root, "src-tauri", "src"), { recursive: true })
  writeFileSync(join(root, "src-tauri", "src", "lib.rs"), libContents, "utf8")
  for (const { path, contents } of tsFiles) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, contents, "utf8")
  }
  mkdirSync(join(root, "scripts", "gates", "lib"), { recursive: true })
  copyFileSync(SCRIPT, join(root, "scripts", "gates", "check-command-parity.mjs"))
  copyFileSync(SHARED_LIB, join(root, "scripts", "gates", "lib", "generate-handler.mjs"))
  spawnSync("git", ["init", "-q"], { cwd: root })
  spawnSync("git", ["config", "user.email", "audit@test"], { cwd: root })
  spawnSync("git", ["config", "user.name", "audit"], { cwd: root })
  spawnSync("git", ["add", "."], { cwd: root })
  spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root })
  return root
}

function runScript(root) {
  return spawnSync("node", [join(root, "scripts", "gates", "check-command-parity.mjs")], {
    cwd: root,
    encoding: "utf8",
  })
}

test("all literal invokes registered exits 0", () => {
  const root = makeFixture({
    libRs: libRs("claude::commands::claude_send", "fleet_get_snapshot"),
    tsFiles: [
      {
        path: "lib/tauri/fleet.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          export const send = () => invoke("claude_send", {})
          export const snap = () => invoke<{ ok: boolean }>("fleet_get_snapshot")
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /2 distinct literal commands all registered/)
  rmSync(root, { recursive: true, force: true })
})

test("unregistered literal invoke exits 1 naming file and line", () => {
  const root = makeFixture({
    libRs: libRs("fleet_get_snapshot"),
    tsFiles: [
      {
        path: "lib/tauri/fleet.ts",
        contents: `import { invoke } from "@tauri-apps/api/core"\nexport const bad = () => invoke("fleet_get_snapsho", {})\n`,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /lib\/tauri\/fleet\.ts:2\s+invoke\("fleet_get_snapsho"\)/)
  rmSync(root, { recursive: true, force: true })
})

test("exempt comment with reason suppresses the finding", () => {
  const root = makeFixture({
    libRs: libRs("fleet_get_snapshot"),
    tsFiles: [
      {
        path: "lib/tauri/fleet.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          // invoke-parity-exempt: backend not shipped yet
          export const pending = () => invoke("future_command", {})
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})

test("bare exempt marker without reason exits 1", () => {
  const root = makeFixture({
    libRs: libRs("fleet_get_snapshot"),
    tsFiles: [
      {
        path: "lib/tauri/fleet.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          // invoke-parity-exempt:
          export const pending = () => invoke("future_command", {})
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /without a reason/)
  rmSync(root, { recursive: true, force: true })
})

test("dynamic invoke is ignored but counted; unused registered reported without failing", () => {
  const root = makeFixture({
    libRs: libRs("used_command", "never_invoked_command"),
    tsFiles: [
      {
        path: "lib/tauri/bridge.ts",
        contents: `
          import { invoke } from "@tauri-apps/api/core"
          export const call = (cmd: string) => invoke(cmd, {})
          export const used = () => invoke("used_command")
        `,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /1 non-literal invoke call\(s\) not checked/)
  assert.match(result.stdout, /1 registered command\(s\) with no literal invoke/)
  rmSync(root, { recursive: true, force: true })
})

test("test and story files are excluded from the scan", () => {
  const root = makeFixture({
    libRs: libRs("real_command"),
    tsFiles: [
      {
        path: "lib/tauri/fleet.test.ts",
        contents: `import { invoke } from "@tauri-apps/api/core"\ninvoke("made_up_in_test")\n`,
      },
      {
        path: "components/x.stories.tsx",
        contents: `import { invoke } from "@tauri-apps/api/core"\ninvoke("made_up_in_story")\n`,
      },
    ],
  })
  const result = runScript(root)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  rmSync(root, { recursive: true, force: true })
})

// --- pure scanSource() unit tests ---

test("scanSource: bare-identifier registration counts", () => {
  const registered = new Set(["bare_command"])
  const { violations } = scanSource("lib/x.ts", `invoke("bare_command")`, registered)
  assert.equal(violations.length, 0)
})

test("scanSource: multi-line invoke with generic type params anchors to the invoke line", () => {
  const registered = new Set()
  const src = `const frame = await invoke<{ data: number[] }>(\n  "multiline_command",\n)`
  const { violations } = scanSource("lib/x.ts", src, registered)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].command, "multiline_command")
  assert.equal(violations[0].line, 1)
})

test("scanSource: tauri plugin-namespaced commands never match", () => {
  const registered = new Set()
  const { violations, dynamicCount } = scanSource(
    "lib/x.ts",
    `invoke("plugin:dialog|open")`,
    registered
  )
  assert.equal(violations.length, 0)
  assert.equal(dynamicCount, 0)
})
