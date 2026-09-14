/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { completeBotRunStep } from "@/lib/db/bot-run-steps"
import { registerBot, __resetBotsForTesting } from "@/lib/plugin/registries/bot-registry"
import {
  registerIntegrationDefinitions,
  __resetIntegrationRegistryForTesting,
} from "@/lib/integrations/registry"
import {
  resolveBotIntegrationBinding,
  assertBotIntegrationAction,
  canonicalIntegrationValue,
} from "./bot-integration-binding"
import type { PluginBotDef } from "@/types/plugin/plugin-bot"

const mockPlugins = { bot: { manifest: { dependencies: { "github-delivery": "*" } } } }
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: { getState: () => ({ plugins: mockPlugins }) },
}))

const ref = { runId: "run", slotId: "github" }
const action = {
  integrationId: "github",
  actionId: "reviewPr",
  input: { repoFullName: "Owner/Repo", body: "Review", prNumber: 1 },
}
const definition: PluginBotDef = {
  id: "monitor",
  name: "Monitor",
  version: "1.0.0",
  executor: "handler",
  triggers: [{ id: "manual", kind: "manual" }],
  requires: {
    credentials: [
      { id: "github", label: "GitHub", integration: "github-delivery", strategy: "pat" },
    ],
    integrationActions: ["github.reviewPr", "github.read", "github.openPr"],
  },
  configSchema: { properties: { repository: { default: "Owner/Repo" } } },
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBotsForTesting()
  __resetIntegrationRegistryForTesting()
  mockPlugins.bot.manifest.dependencies = { "github-delivery": "*" }
  registerBot(
    "monitor",
    { id: "bot:monitor", definition, handler: async () => ({}) },
    { pluginId: "bot" }
  )
  registerIntegrationDefinitions({
    pluginId: "github-delivery",
    definitions: [
      {
        id: "github",
        label: "GitHub",
        resourceKinds: ["repository"],
        eventTypes: [],
        authStrategies: [
          { id: "pat", providerId: "github-pat", type: "personal-access-token", label: "PAT" },
        ],
        actions: ["reviewPr", "read", "openPr"].map((id) => ({
          id,
          label: id,
          handler: id,
          inputSchema: { type: "object" },
          risk: id === "read" ? "read" : "write",
          idempotency: "required",
        })),
      },
    ],
    handlers: {
      "github:reviewPr": async () => ({}),
      "github:read": async () => ({}),
      "github:openPr": async () => ({}),
    },
  })
  await getDb().executionRuns.put({
    id: "run",
    kind: "bot",
    sourceId: "install",
    title: "Bot",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
  })
  await getDb().botInstallations.put({
    id: "install",
    definitionId: "bot:monitor",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    status: "enabled",
    scope: { kind: "account" },
    config: {},
    credentialBindings: { github: { integrationAccountId: "account" } },
    createdAt: 1,
    updatedAt: 1,
  })
  await getDb().integrationAccounts.put({
    id: "account",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: "secret-handle",
    remoteAccountId: "owner",
    label: "Account",
    enabled: true,
    health: "healthy",
    createdAt: "2026-09-12",
    updatedAt: "2026-09-12",
  })
  await getDb().executionRunInterrupts.put({
    id: "approval",
    runId: "run",
    type: "bot_approval",
    title: "Publish",
    status: "approved",
    expiresAt: Date.now() + 60_000,
    createdAt: 1,
    approvalDetail: { approvedActions: [{ actionId: action.actionId, input: action.input }] },
  })
})

it("resolves only a declared installation credential and schema-default repository", async () => {
  await expect(resolveBotIntegrationBinding("bot", ref, "OWNER/REPO")).resolves.toMatchObject({
    repository: "owner/repo",
    account: { id: "account" },
  })
})

it.each([
  ["caller", async () => {}, "other", ref],
  ["slot", async () => {}, "bot", { ...ref, slotId: "unknown" }],
  ["run", async () => {}, "bot", { ...ref, runId: "unknown" }],
  [
    "disabled",
    async () => getDb().botInstallations.update("install", { status: "disabled" }),
    "bot",
    ref,
  ],
  [
    "mirror",
    async () => getDb().botInstallations.update("install", { syncedFromHost: true }),
    "bot",
    ref,
  ],
  [
    "terminal",
    async () => getDb().executionRuns.update("run", { status: "completed" }),
    "bot",
    ref,
  ],
  [
    "version",
    async () => getDb().botInstallations.update("install", { pinnedVersion: "2.0.0" }),
    "bot",
    ref,
  ],
  [
    "revoked",
    async () => getDb().integrationAccounts.update("account", { enabled: false }),
    "bot",
    ref,
  ],
  [
    "strategy",
    async () => getDb().integrationAccounts.update("account", { providerId: "other" }),
    "bot",
    ref,
  ],
  [
    "integration",
    async () => getDb().integrationAccounts.update("account", { integrationId: "other" }),
    "bot",
    ref,
  ],
  [
    "scope",
    async () => getDb().botInstallations.update("install", { config: { repository: "../other" } }),
    "bot",
    ref,
  ],
] as const)("rejects invalid %s authority", async (_name, mutate, caller, binding) => {
  await mutate()
  await expect(resolveBotIntegrationBinding(caller, binding)).rejects.toThrow()
})

it("rejects missing provider dependency and repository widening", async () => {
  await expect(resolveBotIntegrationBinding("bot", ref, "owner/other")).rejects.toThrow("scope")
  mockPlugins.bot.manifest.dependencies = {} as typeof mockPlugins.bot.manifest.dependencies
  await expect(resolveBotIntegrationBinding("bot", ref)).rejects.toThrow("dependency")
})

it("checks exact action approval, repository and declared action allowlist", async () => {
  await expect(assertBotIntegrationAction("bot", ref, action, "approval")).resolves.toBeDefined()
  await expect(
    assertBotIntegrationAction(
      "bot",
      ref,
      { ...action, input: { ...action.input, body: "Changed" } },
      "approval"
    )
  ).rejects.toThrow("match")
  await expect(
    assertBotIntegrationAction("bot", ref, { ...action, actionId: "mergePr" }, "approval")
  ).rejects.toThrow("allowlisted")
  await expect(
    assertBotIntegrationAction(
      "bot",
      ref,
      { ...action, input: { ...action.input, repoFullName: "other/repo" } },
      "approval"
    )
  ).rejects.toThrow("scope")
  await expect(
    assertBotIntegrationAction("bot", ref, { ...action, actionId: "read" })
  ).resolves.toBeDefined()
})

it.each(["pending", "denied", "expired"] as const)("rejects %s approval", async (status) => {
  await getDb().executionRunInterrupts.update("approval", { status })
  await expect(assertBotIntegrationAction("bot", ref, action, "approval")).rejects.toThrow(
    "approval"
  )
})

it("rejects expired or foreign-run approved decisions", async () => {
  await getDb().executionRunInterrupts.update("approval", { expiresAt: 1 })
  await expect(assertBotIntegrationAction("bot", ref, action, "approval")).rejects.toThrow(
    "approval"
  )
  await getDb().executionRunInterrupts.update("approval", {
    expiresAt: Date.now() + 60_000,
    runId: "other",
  })
  await expect(assertBotIntegrationAction("bot", ref, action, "approval")).rejects.toThrow(
    "approval"
  )
})

it("compares JSON object keys canonically while preserving array order", () => {
  expect(canonicalIntegrationValue({ b: [1, 2], a: "x" })).toBe(
    canonicalIntegrationValue({ a: "x", b: [1, 2], absent: undefined })
  )
  expect(canonicalIntegrationValue([1, 2])).not.toBe(canonicalIntegrationValue([2, 1]))
})

it("derives the PR head exclusively from the matching approved host publication", async () => {
  const input = { repoFullName: "Owner/Repo", head: "bot/fix", base: "main", title: "Fix" }
  const snapshot = { id: "snapshot", runId: "run", diff: "approved diff" }
  await getDb().executionRunInterrupts.update("approval", {
    approvalDetail: {
      snapshot,
      publish: { branch: input.head },
      approvedActions: [{ actionId: "openPr", input }],
    },
  })
  const open = { integrationId: "github", actionId: "openPr", input }
  await expect(assertBotIntegrationAction("bot", ref, open, "approval")).rejects.toThrow("snapshot")
  await completeBotRunStep("run", "__host:snapshot:snapshot", snapshot)
  const publication = {
    snapshotId: "snapshot",
    repository: "owner/repo",
    branch: input.head,
    headSha: "a".repeat(40),
  }
  await completeBotRunStep("run", "__host:publication:snapshot", publication)
  await expect(assertBotIntegrationAction("bot", ref, open, "approval")).resolves.toMatchObject({
    approvedPublication: { branch: input.head, headSha: publication.headSha },
  })
  for (const changed of [
    { ...publication, repository: "other/repo" },
    { ...publication, branch: "other" },
    { ...publication, snapshotId: "other" },
  ]) {
    await getDb().botRunSteps.update("run::__host:publication:snapshot", { output: changed })
    await expect(assertBotIntegrationAction("bot", ref, open, "approval")).rejects.toThrow(
      "snapshot"
    )
  }
  await getDb().botRunSteps.update("run::__host:publication:snapshot", { output: publication })
  await getDb().botRunSteps.update("run::__host:snapshot:snapshot", {
    output: { ...snapshot, diff: "changed" },
  })
  await expect(assertBotIntegrationAction("bot", ref, open, "approval")).rejects.toThrow("snapshot")
})

it("revalidates policy-authorized writes against the current explicit installation grant", async () => {
  const grant = { requireApprovalForWrites: false, maxAutonomy: "autopilot" as const }
  await completeBotRunStep(ref.runId, "__host:policy", grant)
  await getDb().botInstallations.update("install", { policyGrant: grant })
  await getDb().executionRunInterrupts.update("approval", {
    approvalDecisionMode: "policy",
    approvalPolicy: { kind: "bot-installation", installationId: "install" },
  })
  await expect(assertBotIntegrationAction("bot", ref, action, "approval")).resolves.toBeDefined()
  await getDb().botInstallations.update("install", {
    policyGrant: { ...grant, requireApprovalForWrites: true },
  })
  await expect(assertBotIntegrationAction("bot", ref, action, "approval")).rejects.toThrow(
    "no longer authorized"
  )
})
