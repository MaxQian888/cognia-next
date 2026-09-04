/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"

import { dispatchIntegrationEventToBots } from "./integration-event"

const NOW = "2026-09-05T09:00:00.000Z"

const OPENED: PluginBotTriggerDef = {
  id: "opened",
  kind: "event",
  source: "integration",
  types: ["pull_request.opened"],
}

function event(overrides: Partial<IntegrationEventEnvelope> = {}): IntegrationEventEnvelope {
  return {
    schemaVersion: 1,
    id: "ie_1",
    pluginId: "github-delivery",
    integrationId: "github",
    accountId: "acct_a",
    deliveryId: "gh-delivery-7",
    eventType: "pull_request.opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { number: 42 },
    actor: { id: "octocat", label: "Octocat" },
    resource: {
      kind: "pull_request",
      id: "42",
      url: "https://x/42",
      parent: { kind: "repo", id: "acme/web" },
    },
    ...overrides,
  }
}

async function install(accountId: string, id = "boti_1") {
  const definition: PluginBotDef = {
    id: "triage",
    name: "Triage",
    version: "1.0.0",
    executor: "handler",
    triggers: [OPENED],
  } as PluginBotDef
  registerBot("triage", { id: "acme:triage", definition, handler: jest.fn() }, { pluginId: "acme" })
  return installBot({
    id,
    definitionId: "acme:triage",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    credentialBindings: { repo: { integrationAccountId: accountId } },
    now: Date.now(),
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botEventDeliveries.clear()
}, 15_000)

describe("dispatchIntegrationEventToBots", () => {
  it("enqueues a delivery for a matching installation", async () => {
    await install("acct_a")
    const result = await dispatchIntegrationEventToBots(event())

    expect(result.enqueued).toHaveLength(1)
    const [row] = result.enqueued
    expect(row.envelope.source).toBe("integration")
    expect(row.envelope.type).toBe("pull_request.opened")
    expect(row.envelope.binding?.integrationAccountId).toBe("acct_a")
  })

  it("never routes another account's events to this installation", async () => {
    await install("acct_a")
    // The difference between two teams sharing a Cognia install and two teams
    // reading each other's pull requests.
    expect((await dispatchIntegrationEventToBots(event({ accountId: "acct_b" }))).enqueued).toEqual(
      []
    )
  })

  it("makes a redelivered webhook the same event", async () => {
    await install("acct_a")
    await dispatchIntegrationEventToBots(event())
    await dispatchIntegrationEventToBots(event({ id: "ie_2" }))

    expect(await getDb().botEventDeliveries.count()).toBe(1)
  })

  it("projects the actor without claiming a verified identity", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event())).enqueued

    expect(row.envelope.actor).toEqual({ kind: "human", id: "octocat", displayName: "Octocat" })
    // A webhook says who acted on the far side, not who they are here.
    expect(row.envelope.actor?.principalId).toBeUndefined()
  })

  it("projects the resource with its parent as the scope", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event())).enqueued

    expect(row.envelope.resource).toEqual({
      kind: "pull_request",
      id: "42",
      url: "https://x/42",
      scope: "acme/web",
    })
  })

  it("falls back to now for an unparseable timestamp", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event({ occurredAt: "not a date" })))
      .enqueued
    expect(Number.isFinite(row.envelope.occurredAt)).toBe(true)
  })

  it("marks the event as nobody's output, so the loop guard lets it through", async () => {
    await install("acct_a")
    const [row] = (await dispatchIntegrationEventToBots(event())).enqueued
    expect(row.envelope.provenance).toEqual({ selfProduced: false, depth: 0 })
  })
})
