/**
 * The Scheduler Tools manifest, checked against the validator the installer
 * runs, and against the two contribution shapes it actually declares.
 *
 * `src/index.test.ts` covers the tool logic and `src/bot.test.ts` covers the
 * digest, and neither can see the manifest. A manifest that fails validation
 * means the plugin never loads at all, which is the failure mode where every
 * unit test is green and the feature does not exist.
 *
 * This plugin is also the FIRST in-tree consumer of the `bot` capability.
 * `bots-bridge.ts` and the bot registry had no plugin exercising them, so the
 * assertions below are as much a contract test for that bridge as for this
 * manifest: they pin the shape the bridge resolves a handler from.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import type { PluginHandlerBotDef, PluginManifest } from "@cognia/plugin-sdk"

import * as pluginModule from "./src/index"
import { scheduleDigestBotDef } from "./src/bot"

const manifest = JSON.parse(readFileSync(join(__dirname, "plugin.json"), "utf8")) as PluginManifest

describe("cognia-scheduler-tools manifest", () => {
  it("passes validation", () => {
    const result = validatePluginManifest(manifest, { governanceMode: "warn" })
    const errors = (result.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.severity === "error"
    )
    expect(errors).toEqual([])
    expect(result.valid).toBe(true)
  })

  it("is a JavaScript frontend plugin, which is what the bots bridge's JS path needs", () => {
    // `isPythonBackedContribution` falls through to the plugin type when a
    // contribution declares no `backend`. A `python` type here would route the
    // handler through the stdio proxy and never import the module at all.
    expect(manifest.type).toBe("frontend")
    expect(manifest.main).toBe("src/index.ts")
  })

  it("declares every capability it contributes through", () => {
    // The module-bridge dispatches on manifest FIELD presence, so a missing
    // capability tag does not break the bridge. It breaks the contract
    // catalogue and the author-facing docs, which is worse: the plugin works
    // and the inventory says it does not exist.
    expect(manifest.capabilities).toEqual(expect.arrayContaining(["tools", "scheduler", "bot"]))
  })

  it("declares every permission the two contributions actually use", () => {
    // `database:read` is the Bot's: the digest reads the user's schedule.
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(["settings:read", "database:read", "database:write", "agent:control"])
    )
  })
})

describe("the Schedule digest Bot contribution", () => {
  const bots = (manifest.bots ?? []) as PluginHandlerBotDef[]
  const bot = bots[0]

  it("declares exactly one Bot", () => {
    expect(bots).toHaveLength(1)
    expect(bot?.id).toBe("schedule-digest")
  })

  it("matches the definition the source declares, field for field", () => {
    // The manifest is what the host reads and `bot.ts` is what an author
    // edits. Two copies of one definition drift the first time only one is
    // updated, and the drift is invisible until an installation pins a version
    // that no longer means what it says.
    expect(bot).toEqual(scheduleDigestBotDef)
  })

  it("names an export the module actually has", () => {
    // This is the whole `handler_missing` failure mode. The bridge takes
    // `mod[def.export]` and refuses anything that is not a function, and the
    // installation then reads as broken with no clue which side is wrong.
    const exportName = bot!.export!
    expect(typeof (pluginModule as Record<string, unknown>)[exportName]).toBe("function")
  })

  it("ships a manual trigger, or Run now would have nothing to attribute a run to", () => {
    expect(bot?.triggers.some((trigger) => trigger.kind === "manual")).toBe(true)
  })

  it("leaves its schedule DISARMED on install", () => {
    // A contribution that arms itself is exactly what `enabledByDefault` is
    // for making deliberate. This one reads the user's whole schedule.
    const cron = bot?.triggers.find((trigger) => trigger.kind === "schedule")
    expect(cron?.enabledByDefault).toBe(false)
  })

  it("needs no credential, which is what makes it runnable out of the box", () => {
    // The scheduler is the one event source with no external account behind
    // it. An installation of this Bot is `enabled`, never `needs_setup`.
    expect(bot?.requires?.credentials ?? []).toEqual([])
  })

  it("declares a real policy ceiling rather than an empty object", () => {
    expect(bot?.policy).toMatchObject({ maxRunDurationMs: 30_000, maxConcurrentRuns: 1 })
  })

  it("ships a config schema, so the installation has settings to render", () => {
    const properties = (bot?.configSchema as { properties?: Record<string, unknown> })?.properties
    expect(properties).toHaveProperty("staleAfterDays")
  })
})
