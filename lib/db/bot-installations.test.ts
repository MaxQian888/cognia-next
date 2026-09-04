/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { PluginBotCredentialSlot } from "@/types/plugin/plugin-bot"

import {
  getBotInstallation,
  installBot,
  isBotTriggerArmed,
  listBotInstallations,
  readBotTriggerState,
  resolveInstallationStatus,
  uninstallBot,
  unboundCredentialSlots,
  updateBotInstallation,
  writeBotTriggerState,
} from "./bot-installations"
import { __resetDbForTesting, getDb } from "./schema"

const NOW = 1_700_000_000_000

const REPO_SLOT: PluginBotCredentialSlot = { id: "repo", label: "Repository" }
const OPTIONAL_SLOT: PluginBotCredentialSlot = { id: "chat", label: "Chat", optional: true }

function input(overrides: Record<string, unknown> = {}) {
  return {
    definitionId: "acme:digest",
    definitionSource: "plugin" as const,
    pinnedVersion: "1.0.0",
    scope: { kind: "account" as const },
    now: NOW,
    ...overrides,
  }
}

describe("unboundCredentialSlots", () => {
  it("is empty when the definition needs nothing", () => {
    expect(unboundCredentialSlots(undefined, {})).toEqual([])
    expect(unboundCredentialSlots([], {})).toEqual([])
  })

  it("ignores optional slots", () => {
    expect(unboundCredentialSlots([OPTIONAL_SLOT], {})).toEqual([])
  })

  it("treats an empty binding object as unbound", () => {
    // A half-finished setup wizard leaves exactly this behind, and calling it
    // bound arms an installation into a guaranteed failure.
    expect(unboundCredentialSlots([REPO_SLOT], { repo: {} })).toEqual(["repo"])
  })

  it("accepts an account, a session or a connector adapter", () => {
    // Which of the three a slot needs is the integration's business, not this
    // table's, so any one of them counts as bound.
    expect(unboundCredentialSlots([REPO_SLOT], { repo: { integrationAccountId: "acct" } })).toEqual(
      []
    )
    expect(unboundCredentialSlots([REPO_SLOT], { repo: { authSessionId: "sess" } })).toEqual([])
    expect(unboundCredentialSlots([REPO_SLOT], { repo: { adapterId: "lark_1" } })).toEqual([])
  })
})

describe("resolveInstallationStatus", () => {
  it("reports needs_setup while a required slot is unbound", () => {
    expect(
      resolveInstallationStatus({ requested: "enabled", requiredCredentials: [REPO_SLOT] })
    ).toBe("needs_setup")
  })

  it("lets a deliberate disable outrank a missing credential", () => {
    // Turning something off is an answer, not a gap.
    expect(
      resolveInstallationStatus({ requested: "disabled", requiredCredentials: [REPO_SLOT] })
    ).toBe("disabled")
  })

  it("enables once every required slot is bound", () => {
    expect(
      resolveInstallationStatus({
        requested: "enabled",
        requiredCredentials: [REPO_SLOT],
        credentialBindings: { repo: { integrationAccountId: "acct" } },
      })
    ).toBe("enabled")
  })
})

describe("isBotTriggerArmed", () => {
  it("defaults to armed when the definition says nothing", () => {
    expect(isBotTriggerArmed({}, { id: "a" })).toBe(true)
  })

  it("honours a definition that ships disarmed", () => {
    expect(isBotTriggerArmed({}, { id: "a", enabledByDefault: false })).toBe(false)
  })

  it("lets the installation override either way", () => {
    expect(isBotTriggerArmed({ triggerOverrides: { a: false } }, { id: "a" })).toBe(false)
    expect(
      isBotTriggerArmed({ triggerOverrides: { a: true } }, { id: "a", enabledByDefault: false })
    ).toBe(true)
  })
})

describe("botInstallations", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botInstallations.clear()
  }, 15_000)

  it("installs enabled when nothing is required", async () => {
    const row = await installBot(input())
    expect(row.id).toMatch(/^boti_/)
    expect(row.status).toBe("enabled")
    expect(row.config).toEqual({})
    expect(await getBotInstallation(row.id)).toEqual(row)
  })

  it("installs as needs_setup when a required slot is unbound", async () => {
    const row = await installBot(input({ requiredCredentials: [REPO_SLOT] }))
    expect(row.status).toBe("needs_setup")
  })

  it("denormalizes the scope so a workspace query can find it", async () => {
    const row = await installBot(input({ scope: { kind: "workspace", workspaceId: "ws_1" } }))
    expect(row.workspaceId).toBe("ws_1")
    expect("projectId" in row).toBe(false)
  })

  it("re-evaluates status when a binding lands", async () => {
    const row = await installBot(input({ requiredCredentials: [REPO_SLOT] }))
    const updated = await updateBotInstallation(row.id, {
      credentialBindings: { repo: { integrationAccountId: "acct" } },
      requiredCredentials: [REPO_SLOT],
      now: NOW + 1,
    })
    expect(updated?.status).toBe("enabled")
  })

  it("keeps the denormalized scope in step when the scope moves", async () => {
    const row = await installBot(input({ scope: { kind: "workspace", workspaceId: "ws_1" } }))
    const moved = await updateBotInstallation(row.id, {
      scope: { kind: "project", workspaceId: "ws_2", projectId: "p_1" },
    })
    expect(moved?.workspaceId).toBe("ws_2")
    expect(moved?.projectId).toBe("p_1")
  })

  it("drops a stale denormalized id when the scope narrows to account", async () => {
    const row = await installBot(input({ scope: { kind: "workspace", workspaceId: "ws_1" } }))
    const moved = await updateBotInstallation(row.id, { scope: { kind: "account" } })
    // A leftover workspaceId would keep listing the Bot under a workspace that
    // no longer owns it.
    expect("workspaceId" in (moved ?? {})).toBe(false)
  })

  it("returns undefined when patching an installation that is not there", async () => {
    expect(await updateBotInstallation("boti_missing", { status: "disabled" })).toBeUndefined()
  })

  it("includes account-wide installations in a workspace query", async () => {
    await installBot(input({ id: "boti_acct", now: NOW }))
    await installBot(
      input({ id: "boti_ws1", scope: { kind: "workspace", workspaceId: "ws_1" }, now: NOW + 1 })
    )
    await installBot(
      input({ id: "boti_ws2", scope: { kind: "workspace", workspaceId: "ws_2" }, now: NOW + 2 })
    )

    const ids = (await listBotInstallations({ workspaceId: "ws_1" })).map((r) => r.id)
    // An account-scoped Bot is armed everywhere, so omitting it would say it is
    // not running here when it is.
    expect(ids).toEqual(["boti_ws1", "boti_acct"])
  })

  it("filters by definition and status", async () => {
    await installBot(input({ id: "boti_a", definitionId: "acme:a" }))
    await installBot(input({ id: "boti_b", definitionId: "acme:b" }))
    await updateBotInstallation("boti_b", { status: "disabled" })

    expect((await listBotInstallations({ definitionId: "acme:a" })).map((r) => r.id)).toEqual([
      "boti_a",
    ])
    expect((await listBotInstallations({ status: "disabled" })).map((r) => r.id)).toEqual([
      "boti_b",
    ])
  })

  it("uninstalls", async () => {
    const row = await installBot(input())
    await uninstallBot(row.id)
    expect(await getBotInstallation(row.id)).toBeUndefined()
  })
})

describe("bot trigger runtime state", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botInstallations.clear()
  }, 15_000)

  it("merges rather than replaces, so two writers do not revert each other", async () => {
    const row = await installBot(input())

    await writeBotTriggerState(row.id, "poll", { cursor: "page-2" }, NOW + 1)
    await writeBotTriggerState(row.id, "poll", { lastFiredAt: NOW + 2 }, NOW + 2)

    expect(await readBotTriggerState(row.id, "poll")).toEqual({
      cursor: "page-2",
      lastFiredAt: NOW + 2,
    })
  })

  it("keeps triggers' state apart", async () => {
    const row = await installBot(input())
    await writeBotTriggerState(row.id, "a", { cursor: "a1" })
    await writeBotTriggerState(row.id, "b", { cursor: "b1" })

    expect((await readBotTriggerState(row.id, "a"))?.cursor).toBe("a1")
    expect((await readBotTriggerState(row.id, "b"))?.cursor).toBe("b1")
  })

  it("returns undefined for an installation that is not there", async () => {
    expect(await writeBotTriggerState("boti_missing", "a", { cursor: "x" })).toBeUndefined()
    expect(await readBotTriggerState("boti_missing", "a")).toBeUndefined()
  })
})
