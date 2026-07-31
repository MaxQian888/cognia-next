import assert from "node:assert/strict"
import { test } from "node:test"
import { AGENT_ICONS, buildManifest, parseIcon } from "./sync-agent-icons.mjs"

const ONE_PATH = `<svg fill="currentColor" viewBox="0 0 24 24"><title>Claude Code</title><path clip-rule="evenodd" d="M1 2h3z" fill-rule="evenodd"></path></svg>`
const TWO_PATHS = `<svg viewBox="0 0 24 24"><title>Gemini CLI</title><path d="M1 1h2z"></path><path d="M3 3h4z"></path></svg>`

test("parseIcon pulls the viewBox, title and path data", () => {
  const icon = parseIcon(ONE_PATH)
  assert.equal(icon.viewBox, "0 0 24 24")
  assert.equal(icon.title, "Claude Code")
  assert.equal(icon.paths.length, 1)
  assert.equal(icon.paths[0].d, "M1 2h3z")
  assert.equal(icon.paths[0].fillRule, "evenodd")
  assert.equal(icon.paths[0].clipRule, "evenodd")
})

test("parseIcon keeps every path, in order", () => {
  const icon = parseIcon(TWO_PATHS)
  assert.deepEqual(
    icon.paths.map((p) => p.d),
    ["M1 1h2z", "M3 3h4z"]
  )
})

test("parseIcon omits rule attributes that are not present", () => {
  const icon = parseIcon(TWO_PATHS)
  assert.equal("fillRule" in icon.paths[0], false)
  assert.equal("clipRule" in icon.paths[0], false)
})

test("parseIcon tolerates a missing title", () => {
  assert.equal(parseIcon(`<svg viewBox="0 0 24 24"><path d="M0 0h1z"/></svg>`).title, null)
})

test("parseIcon refuses an icon it cannot carry", () => {
  // Reducing a gradient-filled icon to bare paths renders a solid blob rather
  // than failing, which is the worst outcome: a wrong mark that looks fine.
  const gradient = `<svg viewBox="0 0 24 24"><defs><linearGradient id="a"/></defs><path d="M0 0h1z"/></svg>`
  assert.throws(() => parseIcon(gradient), /cannot carry/)
  const masked = `<svg viewBox="0 0 24 24"><mask id="m"/><path d="M0 0h1z"/></svg>`
  assert.throws(() => parseIcon(masked), /cannot carry/)
})

test("parseIcon fails loudly on a viewBox-less or path-less file", () => {
  assert.throws(() => parseIcon(`<svg><path d="M0 0h1z"/></svg>`), /viewBox/)
  assert.throws(() => parseIcon(`<svg viewBox="0 0 24 24"></svg>`), /drawable/)
})

test("buildManifest keys every configured agent", () => {
  const manifest = buildManifest(() => ONE_PATH)
  assert.deepEqual(
    Object.keys(manifest.icons),
    AGENT_ICONS.map((a) => a.id)
  )
  for (const { id, file } of AGENT_ICONS) {
    assert.equal(manifest.icons[id].source, file)
  }
})

test("buildManifest records its provenance so the file is not hand-edited", () => {
  const manifest = buildManifest(() => ONE_PATH)
  assert.match(manifest.note, /sync-agent-icons\.mjs/)
  assert.match(manifest.note, /MIT/)
})

test("every configured agent maps to a monochrome source, never a -color one", () => {
  // Spec §3.1 forbids a second palette; a row of vendor colours would turn an
  // index of what plugs in into the logo wall §4.5 rules out.
  for (const { file } of AGENT_ICONS) {
    assert.equal(file.includes("-color"), false, `${file} is a colour variant`)
  }
})

test("agent ids are unique", () => {
  const ids = AGENT_ICONS.map((a) => a.id)
  assert.equal(new Set(ids).size, ids.length)
})
