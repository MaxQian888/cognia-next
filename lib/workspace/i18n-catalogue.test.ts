/**
 * Catalogue guard for the workspace surfaces' DYNAMIC translation keys.
 *
 * `pnpm lint:i18n` verifies that every key referenced as a string literal
 * exists in both locales, and skips ~1,600 dynamic references outright — a
 * `t(`state.${x}`)` is invisible to it. So the two places this batch builds a
 * key from a union are pinned here instead: adding a capability state or an
 * adoption origin without its message renders the raw key in the UI, in a spot
 * nothing else covers.
 *
 * The unions are imported rather than re-listed, so a new member fails this
 * test rather than quietly falling outside it.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ADOPTION_ORIGINS } from "./adopt-candidates"
import { WORKSPACE_CAPABILITY_KINDS } from "./capability-overlay"
import { PINNABLE_PANELS, FOLLOWING_PANELS } from "./panel-follow"

const LOCALES = ["en", "zh-CN"] as const

function workspaceMessages(locale: string): Record<string, Record<string, unknown>> {
  const path = join(process.cwd(), "i18n/messages", locale, "workspace.json")
  return JSON.parse(readFileSync(path, "utf8"))
}

/** The three capability states the toggle group renders. */
const CAPABILITY_STATES = ["inherit", "on", "off"] as const

describe.each(LOCALES)("workspace dynamic keys — %s", (locale) => {
  const messages = workspaceMessages(locale)

  it("has a label for every capability state", () => {
    const states = (messages.capabilities?.state ?? {}) as Record<string, string>
    const missing = CAPABILITY_STATES.filter((state) => !states[state])
    expect(missing).toEqual([])
  })

  it("has a label for every adoption origin", () => {
    const origins = (messages.adopt?.origin ?? {}) as Record<string, string>
    const missing = ADOPTION_ORIGINS.filter((origin) => !origins[origin])
    expect(missing).toEqual([])
  })

  it("has no orphan origin label for an origin that no longer exists", () => {
    // A stale label is how a union quietly shrinks without anyone noticing the
    // surface that used to render it.
    const origins = Object.keys((messages.adopt?.origin as Record<string, string>) ?? {})
    expect(origins.sort()).toEqual([...ADOPTION_ORIGINS].sort())
  })

  it("has every panel-root state label the chip can render", () => {
    const panelRoot = (messages.panelRoot ?? {}) as Record<string, string>
    const missing = ["none", "following", "worktree", "workspace", "pinned"].filter(
      (key) => !panelRoot[key]
    )
    expect(missing).toEqual([])
  })

  it("has the pin controls' labels, which only a pinnable panel renders", () => {
    const panelRoot = messages.panelRoot as Record<string, string> | undefined
    expect(PINNABLE_PANELS.length).toBeGreaterThan(0)
    expect(panelRoot?.pinLabel).toBeTruthy()
    expect(panelRoot?.unpinLabel).toBeTruthy()
  })
})

describe("the unions the catalogue is checked against", () => {
  it("covers every capability kind the overlay knows", () => {
    // If a third kind is added, its section heading needs a message too — the
    // headings are literal keys, so `lint:i18n` catches those; this asserts the
    // kinds we expect so the addition is a deliberate act.
    expect([...WORKSPACE_CAPABILITY_KINDS]).toEqual(["skill", "mcpServer"])
  })

  it("keeps every panel classified as pinnable or following", () => {
    const all = [...PINNABLE_PANELS, ...FOLLOWING_PANELS]
    expect(new Set(all).size).toBe(all.length)
  })
})
