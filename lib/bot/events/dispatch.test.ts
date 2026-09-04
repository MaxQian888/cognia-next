/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { PluginBotDef, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import { installBot, updateBotInstallation } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import { buildBotEventEnvelope } from "./envelope"

import { bindingsForInstalledBot, dispatchBotEvent } from "./dispatch"
import { resolveInstalledBot } from "@/lib/bot/installed-bot"

const NOW = 1_700_000_000_000

const OPENED: PluginBotTriggerDef = {
  id: "opened",
  kind: "event",
  source: "integration",
  types: ["pull_request.opened"],
}

function def(overrides: Partial<PluginBotDef> = {}): PluginBotDef {
  return {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [OPENED],
    ...overrides,
  } as PluginBotDef
}

async function install(
  botId: string,
  definition: PluginBotDef,
  overrides: Record<string, unknown> = {}
) {
  registerBot(botId, { id: `acme:${botId}`, definition, handler: jest.fn() }, { pluginId: "acme" })
  return installBot({
    definitionId: `acme:${botId}`,
    definitionSource: "plugin",
    pinnedVersion: definition.version,
    scope: { kind: "account" },
    now: NOW,
    ...overrides,
  })
}

function envelope(overrides: Record<string, unknown> = {}) {
  const built = buildBotEventEnvelope({
    source: "integration",
    sourceRecordId: "delivery-7",
    type: "pull_request.opened",
    installationId: "placeholder",
    triggerId: "placeholder",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: {},
    resource: { kind: "pull_request", id: "42", scope: "acme/web" },
    ...overrides,
  })
  const { installationId: _i, triggerId: _t, deliveryId: _d, ...routable } = built
  return routable
}

const QUERY = { source: "integration" as const, type: "pull_request.opened" }

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botEventDeliveries.clear()
}, 15_000)

describe("bindingsForInstalledBot", () => {
  it("skips a disarmed trigger rather than letting the router reject it", async () => {
    const installation = await install(
      "digest",
      def({ triggers: [OPENED, { id: "off", kind: "manual", enabledByDefault: false }] })
    )
    const resolved = await resolveInstalledBot(installation)

    // A disarmed trigger must never reach the rejection list, where it would
    // read as a loop guard firing.
    expect(bindingsForInstalledBot(resolved!).map((b) => b.trigger.id)).toEqual(["opened"])
  })

  it("honours an installation override that arms a disarmed trigger", async () => {
    const installation = await install(
      "digest",
      def({ triggers: [{ id: "off", kind: "manual", enabledByDefault: false }] }),
      { triggerOverrides: { off: true } }
    )
    const resolved = await resolveInstalledBot(installation)
    expect(bindingsForInstalledBot(resolved!).map((b) => b.trigger.id)).toEqual(["off"])
  })

  it("carries the installation's bound integration account onto every binding", async () => {
    const installation = await install("digest", def(), {
      credentialBindings: { repo: { integrationAccountId: "acct_a" } },
    })
    const resolved = await resolveInstalledBot(installation)
    expect(bindingsForInstalledBot(resolved!)[0].integrationAccountId).toBe("acct_a")
  })

  it("carries a connector adapter binding", async () => {
    const installation = await install("digest", def(), {
      credentialBindings: { chat: { adapterId: "lark_1" } },
    })
    const resolved = await resolveInstalledBot(installation)
    expect(bindingsForInstalledBot(resolved!)[0].adapterId).toBe("lark_1")
  })
})

describe("dispatchBotEvent", () => {
  it("enqueues one delivery per matching installation", async () => {
    await install("a", def({ id: "a" }))
    await install("b", def({ id: "b" }))

    const result = await dispatchBotEvent({ envelope: envelope(), query: QUERY, now: NOW })

    expect(result.enqueued).toHaveLength(2)
    expect(await getDb().botEventDeliveries.count()).toBe(2)
  })

  it("is idempotent for the same source event", async () => {
    await install("a", def({ id: "a" }))

    await dispatchBotEvent({ envelope: envelope(), query: QUERY, now: NOW })
    await dispatchBotEvent({ envelope: envelope(), query: QUERY, now: NOW + 1 })

    // A redelivered webhook is the same event, so the second pass must find
    // the row rather than write another.
    expect(await getDb().botEventDeliveries.count()).toBe(1)
  })

  it("skips an installation that is not enabled", async () => {
    const installation = await install("a", def({ id: "a" }))
    await updateBotInstallation(installation.id, { status: "disabled" })

    const result = await dispatchBotEvent({ envelope: envelope(), query: QUERY, now: NOW })
    expect(result.enqueued).toEqual([])
  })

  it("reports an installation whose plugin is gone", async () => {
    const installation = await install("a", def({ id: "a" }))
    __resetBotsForTesting()

    const result = await dispatchBotEvent({ envelope: envelope(), query: QUERY, now: NOW })
    expect(result.unresolved).toEqual([installation.id])
    expect(result.enqueued).toEqual([])
  })

  it("reports a loop-guard refusal", async () => {
    const installation = await install("a", def({ id: "a" }))

    const result = await dispatchBotEvent({
      envelope: envelope({
        provenance: { selfProduced: true, depth: 1, producedByInstallationId: installation.id },
      }),
      query: QUERY,
      now: NOW,
    })

    expect(result.enqueued).toEqual([])
    expect(result.rejected).toEqual([
      { installationId: installation.id, triggerId: "opened", reason: "self_produced" },
    ])
  })

  it("applies an organisation ceiling to every installation", async () => {
    const installation = await install("a", def({ id: "a", policy: { allowSelfTriggering: true } }))

    const result = await dispatchBotEvent({
      envelope: envelope({
        provenance: { selfProduced: true, depth: 1, producedByInstallationId: installation.id },
      }),
      query: QUERY,
      now: NOW,
      organizationPolicy: { allowSelfTriggering: false },
    })

    // The definition asked, the organisation refused, and the outer layer wins.
    expect(result.rejected[0].reason).toBe("self_produced")
  })

  it("carries the trigger's debounce onto the enqueued row", async () => {
    await install("a", def({ id: "a", triggers: [{ ...OPENED, debounceMs: 5_000 }] }))

    const [row] = (await dispatchBotEvent({ envelope: envelope(), query: QUERY, now: NOW }))
      .enqueued
    expect(row.nextAttemptAt).toBe(NOW + 5_000)
    expect(row.notBefore).toBe(NOW + 5_000)
  })

  it("carries the interpolated concurrency key onto the enqueued row", async () => {
    const installation = await install(
      "a",
      def({ id: "a", triggers: [{ ...OPENED, concurrencyKey: "{{resource.id}}" }] })
    )

    const [row] = (await dispatchBotEvent({ envelope: envelope(), query: QUERY, now: NOW }))
      .enqueued
    expect(row.concurrencyKey).toBe(`${installation.id}::42`)
  })

  it("narrows to a workspace when the caller scopes it", async () => {
    await install("a", def({ id: "a" }), {
      scope: { kind: "workspace", workspaceId: "ws_1" },
    })
    await install("b", def({ id: "b" }), {
      scope: { kind: "workspace", workspaceId: "ws_2" },
    })

    const result = await dispatchBotEvent({
      envelope: envelope(),
      query: QUERY,
      scope: { workspaceId: "ws_1" },
      now: NOW,
    })
    expect(result.enqueued).toHaveLength(1)
  })
})
