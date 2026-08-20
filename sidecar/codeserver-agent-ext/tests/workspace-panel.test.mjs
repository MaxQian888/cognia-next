import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")
const manifest = JSON.parse(readFileSync(join(EXT_DIR, "package.json"), "utf8"))
const contributes = manifest.contributes

test("the three views the panel renders into are contributed", () => {
  // `workspace-panel.mjs` registers providers for exactly these ids; a view it
  // registers without a contribution is silently invisible.
  assert.deepEqual(
    contributes.views.cognia.map((v) => v.id),
    ["cognia.issues", "cognia.plans", "cognia.runs"]
  )
})

test("the views live in their own activity-bar container", () => {
  assert.equal(contributes.viewsContainers.activitybar[0].id, "cognia")
})

test("every command the extension registers is contributed", () => {
  const source = readFileSync(join(EXT_DIR, "src", "extension.mjs"), "utf8")
  const registered = [...source.matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1])
  const contributed = new Set(contributes.commands.map((c) => c.command))
  for (const command of registered) {
    assert.ok(contributed.has(command), `${command} is registered but not contributed`)
  }
})

test("every contributed command is registered", () => {
  // The other direction matters just as much: a contributed-but-unregistered
  // command shows in the palette and throws when picked.
  const source = readFileSync(join(EXT_DIR, "src", "extension.mjs"), "utf8")
  const registered = new Set([...source.matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]))
  for (const { command } of contributes.commands) {
    assert.ok(registered.has(command), `${command} is contributed but never registered`)
  }
})

test("no user-visible manifest string is hardcoded English", () => {
  // Titles, labels and view names all go through %key% so the nls generator can
  // localize them; a literal here is invisible to a zh-CN user's workbench.
  const visible = [
    ...contributes.commands.flatMap((c) => [c.title, c.category]),
    ...contributes.submenus.map((s) => s.label),
    ...contributes.viewsContainers.activitybar.map((c) => c.title),
    ...contributes.views.cognia.map((v) => v.name),
  ]
  for (const value of visible) {
    assert.match(value, /^%.+%$/, `"${value}" should be an nls placeholder`)
  }
})

test("the settings.json custom-actions island is gone", () => {
  // Prompt actions now come from the unified template platform, pushed with the
  // workspace snapshot. A surviving `configuration` block would let the two
  // definitions diverge again.
  assert.equal(contributes.configuration, undefined)
})

test("the manifest version matches what the host installs", () => {
  // The host skips the side-load when its marker already records this version,
  // so a bumped extension that forgot the Rust constant never reaches anyone.
  const rust = readFileSync(
    join(EXT_DIR, "..", "..", "src-tauri", "src", "codeserver", "process.rs"),
    "utf8"
  )
  const declared = /const AGENT_EXT_VERSION: &str = "([^"]+)"/.exec(rust)?.[1]
  assert.equal(manifest.version, declared)
})
