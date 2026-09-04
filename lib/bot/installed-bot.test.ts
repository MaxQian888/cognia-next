/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import { createBotDefinition } from "@/lib/db/bot-definitions"
import { installBot } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"

import { isRunnableBot, resolveInstalledBot } from "./installed-bot"

const NOW = 1_700_000_000_000
const manual = [{ id: "run", kind: "manual" as const }]

function pluginDef(overrides: Partial<PluginBotDef> = {}): PluginBotDef {
  return {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: manual,
    ...overrides,
  } as PluginBotDef
}

async function installPluginBot(
  def: PluginBotDef,
  overrides: Record<string, unknown> = {},
  handler?: () => void
) {
  registerBot("digest", { id: "acme:digest", definition: def, handler }, { pluginId: "acme" })
  return installBot({
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: def.version,
    scope: { kind: "account" },
    now: NOW,
    ...overrides,
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botDefinitions.clear()
}, 15_000)

describe("resolveInstalledBot", () => {
  it("resolves a plugin definition and its handler", async () => {
    const handler = jest.fn()
    const installation = await installPluginBot(pluginDef(), {}, handler)

    const resolved = await resolveInstalledBot(installation)
    expect(resolved?.definition.source).toBe("plugin")
    expect(resolved?.definition.id).toBe("acme:digest")
    expect(resolved?.definition.handler).toBe(handler)
    expect(resolved?.problems).toEqual([])
  })

  it("resolves a Creator-authored definition from the table", async () => {
    const row = await createBotDefinition({
      name: "Triage",
      executor: "workflow",
      workflow: "wf_1",
      triggers: manual,
      now: NOW,
    })
    const installation = await installBot({
      definitionId: row.id,
      definitionSource: "local",
      pinnedVersion: row.version,
      scope: { kind: "account" },
      now: NOW,
    })

    const resolved = await resolveInstalledBot(installation)
    expect(resolved?.definition.source).toBe("local")
    expect(resolved?.definition.workflow).toBe("wf_1")
  })

  it("returns null when the plugin is gone entirely", async () => {
    const installation = await installPluginBot(pluginDef())
    __resetBotsForTesting()

    // Nothing to run at all is a different answer from "runs with a problem".
    expect(await resolveInstalledBot(installation)).toBeNull()
  })

  it("reports version drift but still resolves", async () => {
    const installation = await installPluginBot(pluginDef({ version: "1.0.0" }))
    registerBot(
      "digest",
      { id: "acme:digest", definition: pluginDef({ version: "1.1.0" }) },
      { pluginId: "acme" }
    )

    const resolved = await resolveInstalledBot(installation)
    // Refusing here would silently stop a Bot after an ordinary plugin update.
    expect(resolved?.definition.version).toBe("1.1.0")
    expect(resolved?.problems).toContainEqual({
      kind: "version_drift",
      pinned: "1.0.0",
      available: "1.1.0",
    })
  })

  it("reports a handler executor whose module never resolved", async () => {
    const installation = await installPluginBot(pluginDef())

    const resolved = await resolveInstalledBot(installation)
    expect(resolved?.problems).toContainEqual({
      kind: "handler_missing",
      definitionId: "acme:digest",
    })
    expect(isRunnableBot(resolved!)).toBe(false)
  })

  it("intersects every policy layer into one ceiling", async () => {
    const installation = await installPluginBot(
      pluginDef({ policy: { maxAutonomy: "act", maxRunCostUsd: 10 } }),
      { policyGrant: { maxAutonomy: "confirm" } },
      jest.fn()
    )

    const resolved = await resolveInstalledBot(installation, {
      organizationPolicy: { maxRunCostUsd: 2 },
      requestPolicy: { maxAutonomy: "autopilot" },
    })

    expect(resolved?.policy.maxAutonomy).toBe("confirm")
    expect(resolved?.policy.maxRunCostUsd).toBe(2)
  })

  it("only carries the target field its executor owns", async () => {
    const installation = await installPluginBot(
      pluginDef({ executor: "workflow", workflow: "wf_1" } as Partial<PluginBotDef>)
    )
    const resolved = await resolveInstalledBot(installation)

    expect(resolved?.definition.workflow).toBe("wf_1")
    expect("team" in (resolved?.definition ?? {})).toBe(false)
    expect("prompt" in (resolved?.definition ?? {})).toBe(false)
  })
})

describe("isRunnableBot", () => {
  it("refuses an installation that is not enabled", async () => {
    const installation = await installPluginBot(pluginDef(), {}, jest.fn())
    const resolved = await resolveInstalledBot(installation)
    expect(isRunnableBot(resolved!)).toBe(true)

    const disabled = {
      ...resolved!,
      installation: { ...installation, status: "disabled" as const },
    }
    expect(isRunnableBot(disabled)).toBe(false)
  })

  it("tolerates version drift, which is a warning and not a stop", async () => {
    const installation = await installPluginBot(pluginDef({ version: "1.0.0" }), {}, jest.fn())
    registerBot(
      "digest",
      { id: "acme:digest", definition: pluginDef({ version: "2.0.0" }), handler: jest.fn() },
      { pluginId: "acme" }
    )
    const resolved = await resolveInstalledBot(installation)
    expect(isRunnableBot(resolved!)).toBe(true)
  })
})
