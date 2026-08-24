/**
 * Coverage guard for ⌘K workspace scoping.
 *
 * The defect this pins: `workspace` defaulted to `all` and only two of the
 * nineteen providers ever read it, so every search leaked other workspaces'
 * conversations, memories and issues with nothing marking them as foreign. The
 * fix was per-provider, which means the next provider added is exactly where it
 * comes back — a new list over a workspace-owning table would leak by default
 * and nobody would notice until a user did.
 *
 * So every provider is classified here, by hand, with a reason. Adding one
 * fails this test until its row is written, which is the point: the decision
 * "does this belong to a workspace" is not one to make implicitly.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { builtinGlobalSearchProviders } from "./providers"

const ALL_PROVIDERS = builtinGlobalSearchProviders()

type Scoping =
  /** Rows belong to a workspace; out of scope they are noise. */
  | "filter"
  /** Machine-wide definitions the workspace only has a preference about. */
  | "demote"
  /** No workspace concept at all — settings, navigation, devices, people. */
  | "global"
  /** Scoped by its own query rather than through `workspaceScope`. */
  | "own-query"

const EXPECTED: Record<string, { scoping: Scoping; why: string }> = {
  "builtin.sessions": {
    scoping: "own-query",
    why: "Filters the session list it is handed, before matching.",
  },
  "builtin.messages": {
    scoping: "own-query",
    why: "Passes projectId into the chat search engine's own query.",
  },
  "builtin.issues": {
    scoping: "own-query",
    why: "Loads issues for one workspace by construction — it takes a projectId.",
  },
  "builtin.memories": {
    scoping: "filter",
    why: "A memory belongs to a workspace; out of scope it is noise.",
  },
  "builtin.skills": {
    scoping: "demote",
    why: "Machine-wide definition; the workspace only holds a capability preference.",
  },
  "builtin.workflows": { scoping: "global", why: "Workflows are machine-wide and unscoped." },
  "builtin.templates": { scoping: "global", why: "The template catalog is machine-wide." },
  "builtin.workspaces": {
    scoping: "global",
    why: "You search workspaces to switch to ANOTHER one; scoping would hide every result.",
  },
  "builtin.navigation": { scoping: "global", why: "App routes." },
  "builtin.settings": { scoping: "global", why: "Settings sections and controls." },
  "builtin.actions": { scoping: "global", why: "Command palette actions." },
  "builtin.characters": { scoping: "global", why: "Characters are defined machine-wide." },
  "builtin.teams": { scoping: "global", why: "Teams are defined machine-wide." },
  "builtin.devices": { scoping: "global", why: "The device fleet is not per-workspace." },
  "builtin.workbench-panels": { scoping: "global", why: "Panels of the shell in front." },
  "builtin.inbox": {
    scoping: "global",
    why: "IM conversations belong to a connector, not a workspace.",
  },
  "builtin.inbox-contacts": { scoping: "global", why: "Contacts belong to a connector." },
  "builtin.mcp-servers": {
    scoping: "global",
    why: "Machine-wide definitions; the settings surface must report what is installed.",
  },
  "builtin.plugins": { scoping: "global", why: "Plugins are machine-wide by design (ADR note)." },
  "builtin.plugin-actions": { scoping: "global", why: "Quick actions contributed by plugins." },
  "builtin.scheduled-tasks": {
    scoping: "global",
    why: "Schedules carry a workspace, but the palette lists them across workspaces on purpose — an unattributed or foreign schedule is exactly what a user searches for when it misfires.",
  },
  "builtin.pi-packages": { scoping: "global", why: "Python packages are machine-wide." },
}

describe("workspace scoping is decided for every provider", () => {
  it("classifies every registered provider", () => {
    const unclassified = ALL_PROVIDERS.map((p) => p.id).filter((id) => !EXPECTED[id])
    // A new provider must state whether its rows belong to a workspace. The
    // default (`all`) is what leaked every other workspace in the first place.
    expect(unclassified).toEqual([])
  })

  it("has no stale classification for a provider that no longer exists", () => {
    const live = new Set(ALL_PROVIDERS.map((p) => p.id))
    expect(Object.keys(EXPECTED).filter((id) => !live.has(id))).toEqual([])
  })

  it("gives every classification a reason", () => {
    for (const [id, entry] of Object.entries(EXPECTED)) {
      expect({ id, length: entry.why.length }).toMatchObject({
        id,
        length: expect.any(Number),
      })
      expect(entry.why.length).toBeGreaterThan(10)
    }
  })
})

describe("the classification matches the code", () => {
  const providersDir = join(__dirname, "providers")
  const sources = readdirSync(providersDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(providersDir, f), "utf8"))
    .join("\n")

  it("declares workspaceScope for each provider classified filter or demote", () => {
    const declared = [...sources.matchAll(/workspaceScope:\s*\{\s*mode:\s*"(filter|demote)"/g)].map(
      (m) => m[1]
    )
    const wanted = Object.values(EXPECTED)
      .map((e) => e.scoping)
      .filter((s) => s === "filter" || s === "demote")
    // Counts, not identities: the aim is that a classification cannot be
    // written without the code that implements it.
    expect(declared.sort()).toEqual(wanted.sort())
  })

  it("keeps the own-query providers reading the workspace filter themselves", () => {
    // A claim of "I scope myself" that the code does not back up is the worst
    // row in this table: it reads as covered and leaks.
    for (const file of ["sessions", "messages", "issues"]) {
      const source = readFileSync(join(providersDir, `${file}.ts`), "utf8")
      expect({ file, scopes: /workspace|projectId/.test(source) }).toEqual({ file, scopes: true })
    }
  })
})
