/** @jest-environment jsdom */
/**
 * Does a verified PagerDuty incident webhook actually reach an installed
 * incident-responder Bot?
 *
 * Lives here, not under `plugins/pagerduty/`, because it is a test of the
 * HOST: it drives the bot-installation store, the bot registry and the
 * integration-event dispatcher against the plugin's real normalizer and Bot.
 * A plugin's own suite must run against the published SDK surface alone
 * (ADR-0156 §5).
 */

import "fake-indexeddb/auto"

import { installBot } from "@/lib/db/bot-installations"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { dispatchIntegrationEventToBots } from "@/lib/bot/sources/integration-event"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"

import {
  INCIDENT_RESPONDER_BOT,
  incidentResponder,
  normalizePagerDuty,
} from "@/plugins/pagerduty/src/index"

const CONTEXT = { pluginId: "pagerduty", integrationId: "pagerduty", accountId: "acct_pd" }

function incidentDelivery(eventType: string, deliveryId = "del-1") {
  return {
    routeId: "route-1",
    deliveryId,
    headers: {},
    receivedAt: "2026-09-17T00:00:00.000Z",
    body: JSON.stringify({
      event: {
        id: `ev-${eventType}`,
        event_type: eventType,
        resource_type: "incident",
        occurred_at: "2026-09-16T23:59:00.000Z",
        agent: { type: "service", id: "svc-9", summary: "Monitoring" },
        data: {
          id: "P1ABC",
          type: "incident",
          title: "DB latency",
          status: "triggered",
          urgency: "high",
          html_url: "https://acme.pagerduty.com/incidents/P1ABC",
          service: { id: "SVC1", summary: "checkout" },
        },
      },
    }),
  }
}

async function installResponder(accountId: string) {
  registerBot(
    INCIDENT_RESPONDER_BOT.id,
    {
      id: `pagerduty:${INCIDENT_RESPONDER_BOT.id}`,
      definition: INCIDENT_RESPONDER_BOT,
      // A handler-executor Bot without a resolved handler is `handler_missing`
      // and never dispatches — the test wires the real export.
      handler: incidentResponder,
    },
    { pluginId: "pagerduty" }
  )
  return installBot({
    id: "boti_pd",
    definitionId: `pagerduty:${INCIDENT_RESPONDER_BOT.id}`,
    definitionSource: "plugin",
    pinnedVersion: INCIDENT_RESPONDER_BOT.version,
    scope: { kind: "account" },
    credentialBindings: { pagerduty: { integrationAccountId: accountId } },
    config: { responderEmail: "oncall@acme.com" },
    // The trigger ships `enabledByDefault: false` (it posts incident notes);
    // installations arm it on purpose.
    triggerOverrides: { "incident-needs-triage": true },
    now: Date.now(),
  })
}

beforeEach(async () => {
  __resetDbForTesting()
  __resetBotsForTesting()
  await getDb().botInstallations.clear()
  await getDb().botEventDeliveries.clear()
}, 15_000)

describe("pagerduty incident → responder routing", () => {
  it("enqueues a delivery when an incident triggers", async () => {
    await installResponder("acct_pd")
    const envelope = normalizePagerDuty(incidentDelivery("incident.triggered"), CONTEXT)
    const result = await dispatchIntegrationEventToBots(envelope)

    expect(result.enqueued).toHaveLength(1)
    const [row] = result.enqueued
    expect(row.envelope.source).toBe("integration")
    expect(row.envelope.type).toBe("incident.triggered")
    expect(row.envelope.binding?.integrationAccountId).toBe("acct_pd")
    // Per-incident serialization key resolves against the normalized envelope.
    expect(row.envelope.resource).toMatchObject({ kind: "incident", id: "P1ABC" })
  })

  it("does not fire on incident.resolved — the responder only opens triage", async () => {
    await installResponder("acct_pd")
    const envelope = normalizePagerDuty(incidentDelivery("incident.resolved"), CONTEXT)
    expect((await dispatchIntegrationEventToBots(envelope)).enqueued).toEqual([])
  })

  it("never routes another account's incidents to this installation", async () => {
    await installResponder("acct_pd")
    const envelope = normalizePagerDuty(incidentDelivery("incident.triggered"), {
      ...CONTEXT,
      accountId: "acct_other",
    })
    expect((await dispatchIntegrationEventToBots(envelope)).enqueued).toEqual([])
  })

  it("deduplicates a PagerDuty retry that arrives with a new host delivery id", async () => {
    // PagerDuty resends an unacknowledged webhook with the same `event.id`;
    // each HTTP attempt gets its own host delivery id. The normalizer keys the
    // envelope on `event.id`, so the retry collapses onto the first delivery.
    await installResponder("acct_pd")
    await dispatchIntegrationEventToBots(
      normalizePagerDuty(incidentDelivery("incident.triggered", "http-attempt-1"), CONTEXT)
    )
    await dispatchIntegrationEventToBots(
      normalizePagerDuty(incidentDelivery("incident.triggered", "http-attempt-2"), CONTEXT)
    )
    expect(await getDb().botEventDeliveries.count()).toBe(1)
  })

  it("deduplicates a redelivered webhook on the same delivery id", async () => {
    await installResponder("acct_pd")
    const envelope = normalizePagerDuty(incidentDelivery("incident.triggered"), CONTEXT)
    await dispatchIntegrationEventToBots(envelope)
    await dispatchIntegrationEventToBots({ ...envelope, id: "ie_second" })
    expect(await getDb().botEventDeliveries.count()).toBe(1)
  })
})
