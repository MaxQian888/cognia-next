/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { PluginBotDef } from "@/types/plugin/plugin-bot"

import type { BotCatalogEntry } from "@/lib/bot/console/catalog"
import { getBotInstallation, installBot, listBotInstallations } from "@/lib/db/bot-installations"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"

import {
  BotDefinitionMissingError,
  BotLifecycleUnavailableError,
  BotNotInstallableError,
  bindBotCredential,
  botInstallMutation,
  installBotFromCatalog,
  setBotExecutionRoute,
  setBotInstallationEnabled,
  uninstallBotInstallation,
  updateBotConfig,
} from "./lifecycle"
import { BotControlTargetMissingError } from "./local"
import { __setBotWriteRouteDepsForTests } from "./route"

const mockRelay = jest.fn()
const cancelLiveBotInstallation = jest.fn((_installationId: string) => 0)
jest.mock("@/lib/bot/runtime/run", () => ({
  ...jest.requireActual("@/lib/bot/runtime/run"),
  cancelLiveBotInstallation: (installationId: string) => cancelLiveBotInstallation(installationId),
}))
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  transport: { call: (...args: unknown[]) => mockRelay(...args) },
}))

// The approval helper's own behaviour is pinned in its test; here it only has
// to be what the relay sends through.
const mockApproval = jest.fn(async (_command: string, args: Record<string, unknown>) => args)
jest.mock("@/lib/tauri/interactive-approval", () => ({
  withInteractiveApproval: (command: string, args: Record<string, unknown>) =>
    mockApproval(command, args),
}))

const NOW = 1_700_000_000_000

let restoreRoute: (() => void) | undefined

function definition(overrides: Partial<PluginBotDef> = {}): PluginBotDef {
  return {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "run", kind: "manual" }],
    ...overrides,
  } as PluginBotDef
}

function register(def: PluginBotDef = definition()) {
  registerBot(
    "digest",
    { id: "acme:digest", definition: def, handler: jest.fn() },
    {
      pluginId: "acme",
    }
  )
}

function entry(overrides: Partial<BotCatalogEntry> = {}): BotCatalogEntry {
  return {
    definitionId: "acme:digest",
    source: "plugin",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "run", kind: "manual" }],
    slots: [],
    requiredSlots: [],
    installedCount: 0,
    unresolvedHandler: false,
    ...overrides,
  }
}

/** Route inputs that put every lifecycle write on the local leg. */
function allowLocal() {
  restoreRoute = __setBotWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalDatabase: () => true,
    isRunnerOwnedHere: () => true,
    getRuntimeSnapshot: (() => ({ target: { kind: "local" } })) as never,
  })
}

beforeEach(async () => {
  __resetBotsForTesting()
  await __resetDbForTesting()
  allowLocal()
})

afterEach(() => {
  restoreRoute?.()
  restoreRoute = undefined
})

describe("the availability gate", () => {
  it.each([
    ["install", () => installBotFromCatalog({ entry: entry(), scope: { kind: "account" } })],
    ["config", () => updateBotConfig("boti_1", {})],
    ["credential bind", () => bindBotCredential("boti_1", "gh", { integrationAccountId: "a" })],
    ["enable", () => setBotInstallationEnabled("boti_1", true)],
    ["uninstall", () => uninstallBotInstallation("boti_1")],
  ])("refuses %s from a shell that does not own the database", async (_label, call) => {
    restoreRoute?.()
    restoreRoute = __setBotWriteRouteDepsForTests({
      isRemoteHostActive: () => false,
      hasLocalDatabase: () => false,
      getRuntimeSnapshot: (() => ({ target: { kind: "companion" } })) as never,
    })
    await expect(call()).rejects.toBeInstanceOf(BotLifecycleUnavailableError)
  })

  it("refuses on a desktop that is driving a remote host, despite always-on", () => {
    // The trap `resolveWritePlaneRoute` exists for: the static baseline still
    // says `always-on` while the local runtimes are torn down.
    restoreRoute?.()
    restoreRoute = __setBotWriteRouteDepsForTests({
      isRemoteHostActive: () => true,
      hasLocalDatabase: () => true,
      getRuntimeSnapshot: (() => ({ target: { kind: "companion" } })) as never,
    })
    return expect(
      installBotFromCatalog({ entry: entry(), scope: { kind: "account" } })
    ).rejects.toMatchObject({ availability: { reason: "host-manifest-missing" } })
  })
})

describe("installBotFromCatalog", () => {
  it("pins the version the picker showed", async () => {
    register(definition({ version: "2.5.0" }))
    const row = await installBotFromCatalog({
      entry: entry({ version: "2.5.0" }),
      scope: { kind: "account" },
    })
    expect(row.pinnedVersion).toBe("2.5.0")
    expect(row.definitionSource).toBe("plugin")
  })

  it("denormalizes a workspace scope so the index can find it", async () => {
    register()
    const row = await installBotFromCatalog({
      entry: entry(),
      scope: { kind: "workspace", workspaceId: "ws_1" },
    })
    expect(row.workspaceId).toBe("ws_1")
  })

  it("opens `needs_setup` when a required slot is unbound", async () => {
    register(definition({ requires: { credentials: [{ id: "gh", label: "GitHub" }] } }))
    const row = await installBotFromCatalog({
      entry: entry({
        slots: [{ id: "gh", label: "GitHub" }],
        requiredSlots: [{ id: "gh", label: "GitHub" }],
      }),
      scope: { kind: "account" },
    })
    expect(row.status).toBe("needs_setup")
  })

  it("opens enabled when every required slot arrives bound", async () => {
    register(definition({ requires: { credentials: [{ id: "gh", label: "GitHub" }] } }))
    const row = await installBotFromCatalog({
      entry: entry({
        slots: [{ id: "gh", label: "GitHub" }],
        requiredSlots: [{ id: "gh", label: "GitHub" }],
      }),
      scope: { kind: "account" },
      credentialBindings: { gh: { integrationAccountId: "iacc_1" } },
    })
    expect(row.status).toBe("enabled")
  })

  it("refuses a handler definition whose module never resolved", async () => {
    await expect(
      installBotFromCatalog({
        entry: entry({ definitionId: "acme:unresolved", unresolvedHandler: true }),
        scope: { kind: "account" },
      })
    ).rejects.toBeInstanceOf(BotNotInstallableError)
    expect(await listBotInstallations({ definitionId: "acme:unresolved" })).toHaveLength(0)
  })

  it("allows a second installation of the same definition", async () => {
    registerBot(
      "twice",
      { id: "acme:twice", definition: definition(), handler: jest.fn() },
      {
        pluginId: "acme",
      }
    )
    const twice = entry({ definitionId: "acme:twice" })
    await installBotFromCatalog({ entry: twice, scope: { kind: "account" } })
    await installBotFromCatalog({
      entry: { ...twice, installedCount: 1 },
      scope: { kind: "account" },
    })
    expect(await listBotInstallations({ definitionId: "acme:twice" })).toHaveLength(2)
  })
})

describe("updateBotConfig", () => {
  it("replaces the blob rather than merging, so a value can be cleared", async () => {
    register(definition({ configSchema: { properties: { channel: { type: "string" } } } }))
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      config: { channel: "#ops", noisy: true },
      now: NOW,
    })
    const updated = await updateBotConfig(installed.id, { channel: "#alerts" })
    expect(updated.config).toEqual({ channel: "#alerts" })
  })

  it("stores a permission profile and cancels live runs when it tightens (ADR-0224 A7)", async () => {
    register(definition())
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      policyGrant: {
        maxAuthority: "acceptEdits",
        maxAutonomy: "confirm",
        requireApprovalForWrites: true,
        permissionProfile: { outbound: "ask" },
      },
      now: NOW,
    })
    const cancel = cancelLiveBotInstallation
    cancel.mockClear()
    const base = {
      maxAuthority: "acceptEdits",
      maxAutonomy: "confirm",
      requireApprovalForWrites: true,
    } as const
    const loosened = await updateBotConfig(
      installed.id,
      {},
      {
        ...base,
        permissionProfile: { outbound: "ask", workspace: "sandbox" },
      }
    )
    expect(loosened.policyGrant?.permissionProfile).toEqual({
      outbound: "ask",
      workspace: "sandbox",
    })
    expect(cancel).not.toHaveBeenCalled()
    await updateBotConfig(installed.id, {}, { ...base, permissionProfile: { outbound: "deny" } })
    expect(cancel).toHaveBeenCalledWith(installed.id)
  })

  it("refuses a profile level a class does not accept", async () => {
    register(definition())
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
    await expect(
      updateBotConfig(installed.id, {}, {
        maxAuthority: "acceptEdits",
        maxAutonomy: "confirm",
        requireApprovalForWrites: true,
        permissionProfile: { outbound: "sandbox" },
      } as never)
    ).rejects.toThrow()
  })

  it("names the installation when there is none", async () => {
    await expect(updateBotConfig("boti_missing", {})).rejects.toBeInstanceOf(
      BotControlTargetMissingError
    )
  })

  it("keeps `needs_setup` instead of promoting a half-configured Bot", async () => {
    // The trap this whole module exists for: `updateBotInstallation` only
    // re-derives status when it is handed the slots, and handed nothing it
    // concludes nothing is unbound.
    register(definition({ requires: { credentials: [{ id: "gh", label: "GitHub" }] } }))
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      requiredCredentials: [{ id: "gh", label: "GitHub" }],
      now: NOW,
    })
    expect(installed.status).toBe("needs_setup")
    const updated = await updateBotConfig(installed.id, { channel: "#alerts" })
    expect(updated.status).toBe("needs_setup")
  })
})

describe("setBotExecutionRoute", () => {
  async function installed() {
    register(definition())
    return installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
  }

  it("stores a route, ends the runs started under the old one, and clears the setup error", async () => {
    const row = await installed()
    await getDb().botInstallations.update(row.id, {
      status: "needs_setup",
      monitor: { lastError: "Choose a Cognia model" },
    })
    cancelLiveBotInstallation.mockClear()
    const updated = await setBotExecutionRoute(row.id, {
      mode: "gateway",
      providerId: "openai",
      modelId: "gpt-5",
    })
    expect(updated.executionRoute).toEqual({
      mode: "gateway",
      providerId: "openai",
      modelId: "gpt-5",
    })
    expect(updated.monitor?.lastError).toBeNull()
    expect(cancelLiveBotInstallation).toHaveBeenCalledWith(row.id)
  })

  it.each(["provider-login", null])(
    "preserves the provider wire key when saving %s",
    async (providerAccountId) => {
      const row = await installed()
      const route = {
        mode: "gateway" as const,
        providerId: "openai",
        modelId: "gpt-5",
        accountId: providerAccountId,
      }
      await setBotExecutionRoute(row.id, route)
      const stored = await getDb().botInstallations.get(row.id)
      expect(stored?.executionRoute).toEqual(route)
      expect(stored?.executionRoute).not.toHaveProperty("providerAccountId")
    }
  )

  it("clears a route with null", async () => {
    const row = await installed()
    await setBotExecutionRoute(row.id, { mode: "native" })
    const cleared = await setBotExecutionRoute(row.id, null)
    expect(cleared).not.toHaveProperty("executionRoute")
  })

  it("refuses a malformed route and a missing installation", async () => {
    const row = await installed()
    await expect(
      setBotExecutionRoute(row.id, { mode: "gateway", providerId: "", modelId: "x" } as never)
    ).rejects.toThrow()
    await expect(setBotExecutionRoute("boti_missing", { mode: "native" })).rejects.toBeInstanceOf(
      BotControlTargetMissingError
    )
  })
})

describe("bindBotCredential", () => {
  async function installNeedingGithub() {
    register(definition({ requires: { credentials: [{ id: "gh", label: "GitHub" }] } }))
    return installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      requiredCredentials: [{ id: "gh", label: "GitHub" }],
      now: NOW,
    })
  }

  it("binds an integration account and clears the setup state", async () => {
    const installed = await installNeedingGithub()
    const updated = await bindBotCredential(installed.id, "gh", {
      integrationAccountId: "iacc_1",
    })
    expect(updated.credentialBindings.gh).toEqual({ integrationAccountId: "iacc_1" })
    expect(updated.status).toBe("enabled")
  })

  it("binds a connector adapter for a slot that names an IM account", async () => {
    const installed = await installNeedingGithub()
    const updated = await bindBotCredential(installed.id, "gh", { adapterId: "adp_1" })
    expect(updated.credentialBindings.gh).toEqual({ adapterId: "adp_1" })
  })

  it("never writes an auth session on its own", async () => {
    // A session is a property of an account, and a binding naming one with no
    // account is a pair the broker cannot resolve.
    const installed = await installNeedingGithub()
    const updated = await bindBotCredential(installed.id, "gh", {
      integrationAccountId: "iacc_1",
    })
    expect(updated.credentialBindings.gh).not.toHaveProperty("authSessionId")
  })

  it("deletes the key when cleared, rather than leaving an empty object", async () => {
    const installed = await installNeedingGithub()
    await bindBotCredential(installed.id, "gh", { integrationAccountId: "iacc_1" })
    const cleared = await bindBotCredential(installed.id, "gh", null)
    expect("gh" in cleared.credentialBindings).toBe(false)
    expect(cleared.status).toBe("needs_setup")
  })

  it("treats an empty binding object as a clear", async () => {
    const installed = await installNeedingGithub()
    await bindBotCredential(installed.id, "gh", { integrationAccountId: "iacc_1" })
    const cleared = await bindBotCredential(installed.id, "gh", {})
    expect("gh" in cleared.credentialBindings).toBe(false)
  })

  it("leaves the other slots alone", async () => {
    register(
      definition({
        requires: {
          credentials: [
            { id: "gh", label: "GitHub" },
            { id: "slack", label: "Slack" },
          ],
        },
      })
    )
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      credentialBindings: { slack: { adapterId: "adp_slack" } },
      requiredCredentials: [
        { id: "gh", label: "GitHub" },
        { id: "slack", label: "Slack" },
      ],
      now: NOW,
    })
    const updated = await bindBotCredential(installed.id, "gh", {
      integrationAccountId: "iacc_1",
    })
    expect(updated.credentialBindings.slack).toEqual({ adapterId: "adp_slack" })
  })

  it("refuses an orphan rather than promoting it to enabled", async () => {
    // `updateBotInstallation` re-derives status whenever bindings change, and
    // with no requirement list to check against it concludes nothing is
    // unbound. Writing a binding onto an orphan would flip a `needs_setup` row
    // to `enabled` while it still cannot run at all.
    const installed = await installBot({
      definitionId: "gone:bot",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      requiredCredentials: [{ id: "gh", label: "GitHub" }],
      now: NOW,
    })
    expect(installed.status).toBe("needs_setup")
    await expect(
      bindBotCredential(installed.id, "gh", { adapterId: "adp_1" })
    ).rejects.toBeInstanceOf(BotDefinitionMissingError)
    expect((await getBotInstallation(installed.id))?.status).toBe("needs_setup")
  })
})

describe("setBotInstallationEnabled", () => {
  it("turns one off", async () => {
    register()
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
    expect((await setBotInstallationEnabled(installed.id, false)).status).toBe("disabled")
  })

  it("refuses to switch on a Bot that is still missing a credential", async () => {
    register(definition({ requires: { credentials: [{ id: "gh", label: "GitHub" }] } }))
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      requiredCredentials: [{ id: "gh", label: "GitHub" }],
      now: NOW,
    })
    await setBotInstallationEnabled(installed.id, false)
    expect((await setBotInstallationEnabled(installed.id, true)).status).toBe("needs_setup")
  })
})

describe("human revision (ADR-0239 instruction epoch)", () => {
  it("advances on every control-plane change a person makes, and not on a plugin patch", async () => {
    register(definition({ requires: { credentials: [{ id: "gh", label: "GitHub" }] } }))
    const row = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      requiredCredentials: [{ id: "gh", label: "GitHub" }],
      now: NOW,
    })
    expect(row.humanRevision).toBeUndefined()

    expect((await updateBotConfig(row.id, { channel: "#a" })).humanRevision).toBe(1)
    expect(
      (await bindBotCredential(row.id, "gh", { integrationAccountId: "iacc_1" })).humanRevision
    ).toBe(2)
    expect((await setBotInstallationEnabled(row.id, false)).humanRevision).toBe(3)
    expect(
      (
        await setBotExecutionRoute(row.id, {
          mode: "gateway",
          providerId: "openai",
          modelId: "gpt-x",
        })
      ).humanRevision
    ).toBe(4)

    // The patch a plugin or the runtime writes leaves it where it was.
    const { updateBotInstallation } = await import("@/lib/db/bot-installations")
    const patched = await updateBotInstallation(row.id, { config: { channel: "#b" } })
    expect(patched?.humanRevision).toBe(4)
  })
})

describe("uninstallBotInstallation", () => {
  it("removes the row", async () => {
    register()
    const installed = await installBot({
      definitionId: "acme:digest",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
    await uninstallBotInstallation(installed.id)
    expect(await getBotInstallation(installed.id)).toBeUndefined()
  })

  it("removes an orphan, which is the one state where removal is all that is left", async () => {
    const installed = await installBot({
      definitionId: "gone:bot",
      definitionSource: "plugin",
      pinnedVersion: "1.0.0",
      scope: { kind: "account" },
      now: NOW,
    })
    await uninstallBotInstallation(installed.id)
    expect(await getBotInstallation(installed.id)).toBeUndefined()
  })

  it("names the installation when there is none", async () => {
    await expect(uninstallBotInstallation("boti_missing")).rejects.toBeInstanceOf(
      BotControlTargetMissingError
    )
  })
})

it("builds one install that carries a whole installation's setup (ADR-0224)", () => {
  expect(
    botInstallMutation(
      {
        entry: entry(),
        scope: { kind: "account" },
        config: { repository: "owner/repo" },
        credentialBindings: { chat: { adapterId: "cai_1" } },
        enabled: false,
        triggerOverrides: { nightly: true },
        policyGrant: {
          maxAuthority: "acceptEdits",
          maxAutonomy: "confirm",
          requireApprovalForWrites: true,
        },
      },
      "op-1"
    )
  ).toEqual({
    operation: "install",
    operationId: "op-1",
    definitionId: "acme:digest",
    version: "1.0.0",
    scope: { kind: "account" },
    config: { repository: "owner/repo" },
    credentialBindings: { chat: { adapterId: "cai_1" } },
    enabled: false,
    triggerOverrides: { nightly: true },
    policyGrant: {
      maxAuthority: "acceptEdits",
      maxAutonomy: "confirm",
      requireApprovalForWrites: true,
    },
  })
  // Absent setup stays absent rather than arriving as explicit defaults.
  expect(
    botInstallMutation({ entry: entry(), scope: { kind: "account" } }, "op-2")
  ).not.toHaveProperty("enabled")
  expect(() =>
    botInstallMutation(
      {
        entry: entry(),
        scope: { kind: "account" },
        credentialBindings: { chat: { adapterId: "a", integrationAccountId: "b" } },
      },
      "op-3"
    )
  ).toThrow("one account or adapter")
})

it("installs switched off when asked, and keeps armed-trigger choices", async () => {
  const installed = await installBotFromCatalog({
    entry: entry(),
    scope: { kind: "account" },
    enabled: false,
    triggerOverrides: { nightly: false },
  })
  expect(installed.status).toBe("disabled")
  expect(installed.triggerOverrides).toEqual({ nightly: false })
})

it("relays installation configuration to a supporting host with stable per-operation identity", async () => {
  restoreRoute?.()
  restoreRoute = __setBotWriteRouteDepsForTests({
    isRemoteHostActive: () => true,
    hasLocalDatabase: () => true,
    activeHostFeatureManifest: () =>
      ({
        schemaVersion: 2,
        features: { "bots.control": { version: 1, operations: ["bot_installation_mutate"] } },
        operations: [{ name: "bot_installation_mutate", healthy: true }],
      }) as never,
  })
  const before = await listBotInstallations()
  mockRelay.mockResolvedValue({ id: "host-install", status: "needs_setup", credentialBindings: {} })
  const result = await installBotFromCatalog({
    entry: entry(),
    scope: { kind: "account" },
    config: { repository: "owner/repo" },
  })
  expect(result.id).toBe("host-install")
  const [command, payload, options] = mockRelay.mock.calls[0]
  expect(command).toBe("bot_installation_mutate")
  expect(payload).toMatchObject({
    operation: "install",
    definitionId: "acme:digest",
    version: "1.0.0",
    config: { repository: "owner/repo" },
  })
  expect(options.idempotencyKey).toBe(payload.operationId)
  expect(payload).not.toHaveProperty("entry")
  expect(await listBotInstallations()).toEqual(before)
  await installBotFromCatalog({
    entry: entry(),
    scope: { kind: "account" },
    credentialBindings: {
      github: { integrationAccountId: "account" },
      chat: { adapterId: "adapter" },
    },
  })
  expect(mockRelay).toHaveBeenLastCalledWith(
    "bot_installation_mutate",
    expect.objectContaining({
      credentialBindings: {
        github: { integrationAccountId: "account" },
        chat: { adapterId: "adapter" },
      },
    }),
    expect.any(Object)
  )
  await expect(
    installBotFromCatalog({
      entry: entry(),
      scope: { kind: "account" },
      credentialBindings: { invalid: { authSessionId: "session-only" } },
    })
  ).rejects.toThrow("one account or adapter")
  await bindBotCredential("host-install", "github", { integrationAccountId: "account" })
  await bindBotCredential("host-install", "chat", { adapterId: "adapter" })
  await bindBotCredential("host-install", "chat", null)
  await expect(
    bindBotCredential("host-install", "github", {
      integrationAccountId: "account",
      adapterId: "adapter",
    })
  ).rejects.toThrow("one account or adapter")
  await uninstallBotInstallation("host-install")
  expect(mockRelay).toHaveBeenLastCalledWith(
    "bot_installation_mutate",
    expect.objectContaining({ operation: "uninstall" }),
    expect.any(Object)
  )
  const grant = {
    maxAuthority: "bypassPermissions",
    maxAutonomy: "autopilot",
    requireApprovalForWrites: false,
  } as const
  await updateBotConfig("host-install", { repository: "owner/repo" }, grant)
  expect(mockRelay).toHaveBeenLastCalledWith(
    "bot_installation_mutate",
    expect.objectContaining({ operation: "config", policyGrant: grant }),
    expect.any(Object)
  )
  await expect(
    updateBotConfig("host-install", {}, { ...grant, maxConcurrentRuns: 99 } as never)
  ).rejects.toThrow()
})

// ADR-0224 A6: a Bot installation change on a paired host is host
// configuration, sent under an admin lease minted for it.
it("sends a relayed installation change under an interactive approval", async () => {
  restoreRoute?.()
  restoreRoute = __setBotWriteRouteDepsForTests({
    isRemoteHostActive: () => true,
    hasLocalDatabase: () => true,
    activeHostFeatureManifest: () =>
      ({
        schemaVersion: 2,
        features: { "bots.control": { version: 1, operations: ["bot_installation_mutate"] } },
        operations: [{ name: "bot_installation_mutate", healthy: true }],
      }) as never,
  })
  mockApproval.mockImplementationOnce(async (_command, args) => ({ ...args, adminLease: "lease" }))
  mockRelay.mockResolvedValue({ id: "host-install", status: "disabled", credentialBindings: {} })
  await uninstallBotInstallation("host-install")
  expect(mockApproval).toHaveBeenLastCalledWith(
    "bot_installation_mutate",
    expect.objectContaining({ operation: "uninstall" })
  )
  expect(mockRelay).toHaveBeenLastCalledWith(
    "bot_installation_mutate",
    expect.objectContaining({ operation: "uninstall", adminLease: "lease" }),
    expect.any(Object)
  )
})

it("refuses local configuration mutations against a synced host mirror after disconnect", async () => {
  register()
  const mirrored = await installBot({
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
  })
  await getDb().botInstallations.update(mirrored.id, { syncedFromHost: true })
  for (const operation of [
    () => updateBotConfig(mirrored.id, {}),
    () => bindBotCredential(mirrored.id, "slot", null),
    () => setBotInstallationEnabled(mirrored.id, false),
    () => uninstallBotInstallation(mirrored.id),
  ])
    await expect(operation()).rejects.toMatchObject({ code: "bot_lifecycle_unavailable" })
  expect(await getBotInstallation(mirrored.id)).toMatchObject({ syncedFromHost: true })
})

describe("plugin lifecycle hooks", () => {
  const registerWithHooks = (
    lifecycle: Partial<Record<"onInstall" | "onConfigure" | "onArm" | "onUninstall", jest.Mock>>
  ) =>
    registerBot(
      "digest",
      { id: "acme:digest", definition: definition(), handler: jest.fn(), lifecycle },
      { pluginId: "acme" }
    )

  it("invokes onInstall with the row about to be written", async () => {
    const onInstall = jest.fn()
    registerWithHooks({ onInstall })
    const row = await installBotFromCatalog({
      entry: entry(),
      scope: { kind: "account" },
      config: { channel: "#alerts" },
    })
    expect(onInstall).toHaveBeenCalledTimes(1)
    const ctx = onInstall.mock.calls[0][0]
    expect(ctx.installation.id).toBe(row.id)
    expect(ctx.installation.config).toEqual({ channel: "#alerts" })
    expect(ctx.installation.definitionId).toBe("acme:digest")
    expect(ctx).not.toHaveProperty("previousConfig")
  })

  it("lets onInstall veto: a throw aborts the write and no row remains", async () => {
    const onInstall = jest.fn(() => {
      throw new Error("refuse this tenant")
    })
    registerWithHooks({ onInstall })
    const before = await listBotInstallations({ definitionId: "acme:digest" })
    await expect(
      installBotFromCatalog({ entry: entry(), scope: { kind: "account" } })
    ).rejects.toMatchObject({ name: "BotLifecycleHookError", phase: "onInstall" })
    expect(await listBotInstallations({ definitionId: "acme:digest" })).toHaveLength(before.length)
  })

  it("runs onInstall again for a genuinely second installation", async () => {
    const onInstall = jest.fn()
    registerWithHooks({ onInstall })
    await installBotFromCatalog({ entry: entry(), scope: { kind: "account" } })
    await installBotFromCatalog({ entry: entry(), scope: { kind: "account" } })
    expect(onInstall).toHaveBeenCalledTimes(2)
  })

  it("invokes onConfigure with the previous config and the new snapshot", async () => {
    const onConfigure = jest.fn()
    registerWithHooks({ onConfigure })
    const installed = await installBotFromCatalog({
      entry: entry(),
      scope: { kind: "account" },
      config: { channel: "#old" },
    })
    await updateBotConfig(installed.id, { channel: "#new" })
    expect(onConfigure).toHaveBeenCalledTimes(1)
    const ctx = onConfigure.mock.calls[0][0]
    expect(ctx.previousConfig).toEqual({ channel: "#old" })
    expect(ctx.installation.config).toEqual({ channel: "#new" })
  })

  it("lets onConfigure veto: the stored config is untouched", async () => {
    registerWithHooks({
      onConfigure: jest.fn(() => Promise.reject(new Error("invalid for us"))),
    })
    const installed = await installBotFromCatalog({
      entry: entry(),
      scope: { kind: "account" },
      config: { channel: "#old" },
    })
    await expect(updateBotConfig(installed.id, { channel: "#new" })).rejects.toMatchObject({
      phase: "onConfigure",
    })
    expect((await getBotInstallation(installed.id))?.config).toEqual({ channel: "#old" })
  })

  it("invokes onUninstall before the row is deleted", async () => {
    const onUninstall = jest.fn()
    registerWithHooks({ onUninstall })
    const installed = await installBotFromCatalog({
      entry: entry(),
      scope: { kind: "account" },
    })
    await uninstallBotInstallation(installed.id)
    expect(onUninstall).toHaveBeenCalledTimes(1)
    expect(onUninstall.mock.calls[0][0].installation.id).toBe(installed.id)
    expect(await getBotInstallation(installed.id)).toBeUndefined()
  })

  it("cannot be blocked: a failing onUninstall still removes the row", async () => {
    registerWithHooks({
      onUninstall: jest.fn(() => Promise.reject(new Error("hook exploded"))),
    })
    const installed = await installBotFromCatalog({
      entry: entry(),
      scope: { kind: "account" },
    })
    await expect(uninstallBotInstallation(installed.id)).resolves.toBeUndefined()
    expect(await getBotInstallation(installed.id)).toBeUndefined()
  })

  it("skips hooks for a local definition, which has no module", async () => {
    const row = await installBotFromCatalog({
      entry: entry({ definitionId: "local-1", source: "local" }),
      scope: { kind: "account" },
    })
    // Reaching here means no registry lookup or hook ran — a local row
    // installs with no plugin involvement at all.
    expect(row.definitionSource).toBe("local")
  })
})
