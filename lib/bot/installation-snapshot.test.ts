/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { ResolvedBotDefinition } from "@/lib/bot/installed-bot"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import { __resetDbForTesting } from "@/lib/db/schema"

import { projectBotInstallationSnapshot } from "./installation-snapshot"

function definition(overrides: Partial<ResolvedBotDefinition> = {}): ResolvedBotDefinition {
  return {
    id: "acme:digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [
      { id: "run", kind: "manual" },
      { id: "cron", kind: "schedule", cron: "0 9 * * *", enabledByDefault: false },
    ],
    source: "plugin",
    configSchema: { properties: { channel: { type: "string", default: "#general" } } },
    requires: {
      credentials: [
        { id: "gh", label: "GitHub" },
        { id: "opt", label: "Opt", optional: true },
      ],
    },
    ...overrides,
  }
}

function installation(overrides: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: { extra: 1 },
    credentialBindings: {},
    createdAt: 1_000,
    updatedAt: 1_500,
    ...overrides,
  }
}

beforeEach(async () => {
  await __resetDbForTesting()
})

describe("projectBotInstallationSnapshot", () => {
  it("merges configSchema defaults under the stored config", async () => {
    const snapshot = await projectBotInstallationSnapshot(installation(), definition())
    expect(snapshot.config).toEqual({ channel: "#general", extra: 1 })
  })

  it("projects trigger armed state from overrides and defaults", async () => {
    const snapshot = await projectBotInstallationSnapshot(
      installation({ triggerOverrides: { cron: true } }),
      definition()
    )
    expect(snapshot.triggers).toEqual([
      { id: "run", kind: "manual", armed: true },
      { id: "cron", kind: "schedule", armed: true },
    ])
  })

  it("reports bound slots as booleans and never leaks binding ids", async () => {
    const snapshot = await projectBotInstallationSnapshot(
      installation({
        credentialBindings: {
          gh: { integrationAccountId: "iacc_secret", authSessionId: "sess_secret" },
        },
      }),
      definition()
    )
    expect(snapshot.credentialSlots).toEqual([
      { id: "gh", optional: false, bound: true },
      { id: "opt", optional: true, bound: false },
    ])
    expect(JSON.stringify(snapshot)).not.toContain("iacc_secret")
    expect(JSON.stringify(snapshot)).not.toContain("sess_secret")
  })

  it("is deterministic: two calls on the same row produce equal snapshots", async () => {
    const row = installation()
    const def = definition()
    expect(await projectBotInstallationSnapshot(row, def)).toEqual(
      await projectBotInstallationSnapshot(row, def)
    )
  })
})
