import {
  INCIDENT_RESPONDER_BOT,
  PAGERDUTY_ONCALL_PACK,
  PagerDutyIntegrationError,
  acknowledgePagerDutyIncident,
  addPagerDutyIncidentNote,
  checkPagerDutyHealth,
  createIncidentResponder,
  escalatePagerDutyIncident,
  getPagerDutyIncident,
  incidentResponder,
  listPagerDutyIncidentNotes,
  listPagerDutyResources,
  manifest,
  normalizePagerDuty,
  pagerDutyIntegration,
  resolvePagerDutyIncident,
} from "./index"
import type {
  IntegrationActionHandlerContext,
  IntegrationProviderContext,
  IntegrationVerifiedDelivery,
} from "@cognia/plugin-sdk"

const CONTEXT = { pluginId: "pagerduty", integrationId: "pagerduty", accountId: "acct-1" }

function delivery(body: unknown, overrides: Partial<IntegrationVerifiedDelivery> = {}) {
  return {
    routeId: "route-1",
    deliveryId: "del-1",
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
    receivedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  } satisfies IntegrationVerifiedDelivery
}

function incidentEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: "ev-1",
      event_type: "incident.triggered",
      resource_type: "incident",
      occurred_at: "2026-09-16T23:59:00.000Z",
      agent: { type: "service", id: "svc-9", summary: "Monitoring" },
      data: {
        id: "P1ABC",
        type: "incident",
        title: "DB latency",
        summary: "DB latency on db-1",
        status: "triggered",
        urgency: "high",
        html_url: "https://acme.pagerduty.com/incidents/P1ABC",
        service: { id: "SVC1", summary: "checkout", type: "service_reference" },
      },
      ...overrides,
    },
  }
}

describe("normalizePagerDuty", () => {
  it("maps an incident event onto the canonical envelope", () => {
    const envelope = normalizePagerDuty(delivery(incidentEvent()), CONTEXT)
    expect(envelope.schemaVersion).toBe(1)
    expect(envelope.eventType).toBe("incident.triggered")
    expect(envelope.id).toBe("del-1:ev-1")
    expect(envelope.resource).toEqual({
      kind: "incident",
      id: "P1ABC",
      name: "DB latency",
      url: "https://acme.pagerduty.com/incidents/P1ABC",
    })
    expect(envelope.actor).toEqual({
      id: "svc-9",
      label: "Monitoring",
      avatarUrl: undefined,
    })
    expect(envelope.occurredAt).toBe("2026-09-16T23:59:00.000Z")
    expect(envelope.receivedAt).toBe("2026-09-17T00:00:00.000Z")
    const incident = (envelope.payload as { incident?: Record<string, unknown> }).incident
    expect(incident?.urgency).toBe("high")
    expect((incident?.service as { summary: string }).summary).toBe("checkout")
  })

  it("keeps non-incident resource kinds and projects payload under that kind", () => {
    const envelope = normalizePagerDuty(
      delivery(
        incidentEvent({
          event_type: "service.updated",
          resource_type: "service",
          data: { id: "SVC1", type: "service", summary: "checkout" },
        })
      ),
      CONTEXT
    )
    expect(envelope.eventType).toBe("service.updated")
    expect(envelope.resource).toEqual({
      kind: "service",
      id: "SVC1",
      name: "checkout",
      url: undefined,
    })
    const payload = envelope.payload as Record<string, unknown>
    expect(payload.incident).toBeUndefined()
    expect((payload.service as { id: string }).id).toBe("SVC1")
  })

  it("falls back to delivery.eventType and deliveryId when the event is sparse", () => {
    const envelope = normalizePagerDuty(
      delivery({ event: {} }, { eventType: "incident.annotated" }),
      CONTEXT
    )
    expect(envelope.eventType).toBe("incident.annotated")
    expect(envelope.id).toBe("del-1:incident.annotated")
    expect(envelope.resource).toBeUndefined()
    expect(envelope.actor).toBeUndefined()
    expect(envelope.occurredAt).toBe("2026-09-17T00:00:00.000Z")
  })
})

function handlerContext(
  impl: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
  ) => Promise<{
    status: number
    headers: Record<string, string>
    data: unknown
  }>
): IntegrationActionHandlerContext {
  return {
    pluginId: "pagerduty",
    integrationId: "pagerduty",
    accountId: "acct-1",
    jobId: "job-1",
    signal: new AbortController().signal,
    authenticatedRequest: impl as IntegrationActionHandlerContext["authenticatedRequest"],
  }
}

describe("action handlers", () => {
  it("getIncident GETs the incident path", async () => {
    const calls: Array<{ url: string; method?: string }> = []
    const ctx = handlerContext(async (url, init) => {
      calls.push({ url, method: init?.method })
      return { status: 200, headers: {}, data: { incident: { id: "P1" } } }
    })
    const data = (await getPagerDutyIncident({ incidentId: "P1 ABC" }, ctx)) as {
      incident: { id: string }
    }
    expect(calls).toEqual([{ url: "https://api.pagerduty.com/incidents/P1%20ABC", method: "GET" }])
    expect(data.incident.id).toBe("P1")
  })

  it("addIncidentNote POSTs the note with the From header", async () => {
    let seen:
      | { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }
      | undefined
    const ctx = handlerContext(async (url, init) => {
      seen = { url, init }
      return { status: 201, headers: {}, data: { note: { id: "n1" } } }
    })
    await addPagerDutyIncidentNote(
      { incidentId: "P1", content: "triaged: deploy abc123", from: "oncall@acme.com" },
      ctx
    )
    expect(seen?.init?.method).toBe("POST")
    expect(seen?.init?.headers?.from).toBe("oncall@acme.com")
    expect(JSON.parse(seen?.init?.body ?? "{}")).toEqual({
      note: { content: "triaged: deploy abc123" },
    })
  })

  it("acknowledge PUTs status=acknowledged with From", async () => {
    let body: unknown
    const ctx = handlerContext(async (_url, init) => {
      body = JSON.parse(init?.body ?? "{}")
      return { status: 200, headers: {}, data: {} }
    })
    await acknowledgePagerDutyIncident({ incidentId: "P1", from: "a@b.c" }, ctx)
    expect(body).toEqual({
      incident: { type: "incident_reference", status: "acknowledged" },
    })
  })

  it("resolve PUTs status=resolved", async () => {
    let body: unknown
    const ctx = handlerContext(async (_url, init) => {
      body = JSON.parse(init?.body ?? "{}")
      return { status: 200, headers: {}, data: {} }
    })
    await resolvePagerDutyIncident({ incidentId: "P1", from: "a@b.c" }, ctx)
    expect(body).toEqual({
      incident: { type: "incident_reference", status: "resolved" },
    })
  })

  it("escalate validates escalationLevel and PUTs it", async () => {
    const ctx = handlerContext(async () => ({ status: 200, headers: {}, data: {} }))
    await expect(
      escalatePagerDutyIncident({ incidentId: "P1", from: "a@b.c" }, ctx)
    ).rejects.toThrow("escalationLevel")
    let body: unknown
    const ok = handlerContext(async (_url, init) => {
      body = JSON.parse(init?.body ?? "{}")
      return { status: 200, headers: {}, data: {} }
    })
    await escalatePagerDutyIncident({ incidentId: "P1", escalationLevel: 2, from: "a@b.c" }, ok)
    expect(body).toEqual({
      incident: { type: "incident_reference", escalation_level: 2 },
    })
  })

  it("write actions refuse without a From identity", async () => {
    const ctx = handlerContext(async () => ({ status: 200, headers: {}, data: {} }))
    await expect(addPagerDutyIncidentNote({ incidentId: "P1", content: "x" }, ctx)).rejects.toThrow(
      "from"
    )
    await expect(acknowledgePagerDutyIncident({ incidentId: "P1" }, ctx)).rejects.toThrow("from")
  })

  it("maps error statuses to typed categories", async () => {
    const unauthorized = handlerContext(async () => ({
      status: 401,
      headers: {},
      data: { error: { message: "bad token" } },
    }))
    const err = await getPagerDutyIncident({ incidentId: "P1" }, unauthorized).catch(
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(PagerDutyIntegrationError)
    expect((err as PagerDutyIntegrationError).category).toBe("authentication")
    expect((err as PagerDutyIntegrationError).message).toContain("bad token")
  })

  it("honors apiBaseUrl for non-default deployments", async () => {
    let url = ""
    const ctx = handlerContext(async (u) => {
      url = u
      return { status: 200, headers: {}, data: {} }
    })
    ctx.apiBaseUrl = "https://pd.example.com/"
    await listPagerDutyIncidentNotes({ incidentId: "P1" }, ctx)
    expect(url).toBe("https://pd.example.com/incidents/P1/notes")
  })
})

describe("listPagerDutyResources", () => {
  const providerCtx = (
    impl: (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string }
    ) => Promise<{
      status: number
      headers: Record<string, string>
      data: unknown
    }>
  ): IntegrationProviderContext => ({
    pluginId: "pagerduty",
    integrationId: "pagerduty",
    accountId: "acct-1",
    authenticatedRequest: impl as IntegrationProviderContext["authenticatedRequest"],
  })

  it("lists services with pagination", async () => {
    const ctx = providerCtx(async () => ({
      status: 200,
      headers: {},
      data: {
        services: [
          { id: "S1", summary: "checkout" },
          { id: "S2", summary: "billing" },
        ],
        more: true,
      },
    }))
    const page = await listPagerDutyResources(
      { accountId: "acct-1", kind: "service", cursor: "25", limit: 25 },
      ctx
    )
    expect(page.items).toHaveLength(2)
    expect(page.items[0]).toMatchObject({ kind: "service", id: "S1" })
    expect(page.nextCursor).toBe("50")
  })

  it("lists open incidents with their parent service", async () => {
    const ctx = providerCtx(async () => ({
      status: 200,
      headers: {},
      data: {
        incidents: [
          {
            id: "P1",
            title: "DB latency",
            service: { id: "S1" },
          },
        ],
        more: false,
      },
    }))
    const page = await listPagerDutyResources({ accountId: "acct-1", kind: "incident" }, ctx)
    expect(page.items[0]).toMatchObject({
      kind: "incident",
      id: "P1",
      parent: { kind: "service", id: "S1" },
    })
    expect(page.nextCursor).toBeUndefined()
  })
})

describe("checkPagerDutyHealth", () => {
  const ctx = (status: number): IntegrationProviderContext => ({
    pluginId: "pagerduty",
    integrationId: "pagerduty",
    accountId: "acct-1",
    authenticatedRequest: (async () => ({
      status,
      headers: {} as Record<string, string>,
      data: {},
    })) as IntegrationProviderContext["authenticatedRequest"],
  })

  it("reports healthy on 2xx", async () => {
    await expect(checkPagerDutyHealth(ctx(200))).resolves.toEqual({ health: "healthy" })
  })
  it("reports revoked on 401", async () => {
    await expect(checkPagerDutyHealth(ctx(401))).resolves.toEqual({ health: "revoked" })
  })
  it("reports degraded on transient failure", async () => {
    await expect(checkPagerDutyHealth(ctx(503))).resolves.toEqual({ health: "degraded" })
  })
})

describe("manifest contributions", () => {
  it("declares the integration with multi-signature ingress verification", () => {
    const ingress = pagerDutyIntegration.ingress
    expect(ingress?.verification).toMatchObject({
      type: "hmac-sha256",
      signatureHeader: "x-pagerduty-signature",
      encoding: "hex",
      prefix: "v1=",
      signatureListSeparator: ",",
    })
    expect(pagerDutyIntegration.authStrategies[0]?.requestAuth).toEqual({
      type: "header",
      name: "Authorization",
      prefix: "Token token=",
    })
    expect(pagerDutyIntegration.eventTypes.map((t) => t.id)).toContain("incident.triggered")
  })

  it("arms the responder on incident events and keeps writes to notes only", () => {
    // Handler executor: the triage turn produces text, and the note write is
    // a brokered action the handler executes after approval — brokered
    // actions are not a tool surface a bare agent-turn Bot can call.
    expect(INCIDENT_RESPONDER_BOT.executor).toBe("handler")
    expect(INCIDENT_RESPONDER_BOT.entry).toBe("src/index.ts")
    expect(INCIDENT_RESPONDER_BOT.export).toBe("incidentResponder")
    expect(INCIDENT_RESPONDER_BOT.triggers[0]).toMatchObject({
      kind: "event",
      source: "integration",
      concurrencyKey: "pagerduty:{{resource.id}}",
    })
    const granted = INCIDENT_RESPONDER_BOT.requires?.integrationActions ?? []
    expect(granted).toEqual(
      expect.arrayContaining([
        "pagerduty.getIncident",
        "pagerduty.listIncidentNotes",
        "pagerduty.addIncidentNote",
      ])
    )
    // Acknowledge / resolve / escalate are catalog actions, not responder
    // permissions — a Bot must never own incident state.
    expect(granted).not.toContain("pagerduty.acknowledgeIncident")
    expect(granted).not.toContain("pagerduty.resolveIncident")
    expect(granted).not.toContain("pagerduty.escalateIncident")
    expect(INCIDENT_RESPONDER_BOT.policy?.allowSelfTriggering).toBe(false)
  })

  it("ships the responder character the Bot speaks as", () => {
    const pack = PAGERDUTY_ONCALL_PACK
    const responder = pack.characters.find((c) => c.localId === "responder")
    expect(responder).toBeDefined()
    expect(INCIDENT_RESPONDER_BOT.character).toBe(`cognia-pack:pagerduty:${pack.id}:responder`)
  })

  it("merges contribution fields over plugin.json", () => {
    expect(manifest.id).toBe("pagerduty")
    expect(manifest.integrations?.[0]?.id).toBe("pagerduty")
    expect(manifest.bots?.[0]?.id).toBe("incident-responder")
    expect(manifest.characterPacks?.[0]?.id).toBe("oncall")
  })
})

// ---------------------------------------------------------------------------
// Responder handler
// ---------------------------------------------------------------------------

function runContext(overrides: Record<string, unknown> = {}) {
  const steps: Array<{ name: string; fn: () => unknown }> = []
  return {
    runId: "run-1",
    installationId: "install-1",
    botId: "pagerduty:incident-responder",
    cwd: "/tmp/oncall",
    event: {
      eventId: "ev-1",
      deliveryId: "del-1",
      source: "integration",
      type: "incident.triggered",
      installationId: "install-1",
      triggerId: "incident-needs-triage",
      occurredAt: 1,
      receivedAt: 1,
      resource: {
        kind: "incident",
        id: "P1ABC",
        url: "https://acme.pagerduty.com/incidents/P1ABC",
      },
      payload: {
        incident: {
          id: "P1ABC",
          title: "DB latency",
          status: "triggered",
          urgency: "high",
          service: { id: "SVC1", summary: "checkout" },
        },
      },
      provenance: { selfProduced: false, depth: 0 },
    },
    config: { responderEmail: "oncall@acme.com", minUrgency: "low" },
    signal: new AbortController().signal,
    step: {
      run: jest.fn(async (_name: string, fn: () => unknown) => fn()),
      waitForApproval: jest.fn(async () => ({
        outcome: "approved",
        approvalId: "interrupt-1",
        decidedAt: 2,
      })),
    },
    log: jest.fn(),
    progress: jest.fn(),
    steps,
    ...overrides,
  }
}

function pluginContext(turnResult: unknown, jobResult: unknown) {
  const runCharacterTurn = jest.fn(async () => turnResult)
  const executeAction = jest.fn(async () => jobResult)
  return {
    context: {
      agent: { runCharacterTurn },
      integrations: { executeAction },
    },
    runCharacterTurn,
    executeAction,
  }
}

const TRIAGE_DONE = { sessionId: "s1", status: "completed", text: "Likely cause: bad deploy." }
const JOB_OK = { id: "job-1", status: "succeeded", output: { note: { id: "n1" } } }

describe("incidentResponder handler", () => {
  it("triages, asks approval with the exact note input, then posts through the broker", async () => {
    const { context, runCharacterTurn, executeAction } = pluginContext(TRIAGE_DONE, JOB_OK)
    const run = runContext()
    const result = await createIncidentResponder(context as never)(run as never)

    expect(runCharacterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        characterId: "cognia-pack:pagerduty:oncall:responder",
        cwd: "/tmp/oncall",
      })
    )
    expect(run.step.waitForApproval).toHaveBeenCalledWith(
      "post-note",
      expect.objectContaining({
        risk: "medium",
        detail: expect.objectContaining({
          approvedActions: [
            {
              actionId: "addIncidentNote",
              input: {
                incidentId: "P1ABC",
                content: "Likely cause: bad deploy.",
                from: "oncall@acme.com",
              },
            },
          ],
        }),
      })
    )
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: "pagerduty",
        actionId: "addIncidentNote",
        binding: { runId: "run-1", slotId: "pagerduty" },
        approval: { interruptId: "interrupt-1" },
        idempotencyKey: "pagerduty:del-1:note",
        input: {
          incidentId: "P1ABC",
          content: "Likely cause: bad deploy.",
          from: "oncall@acme.com",
        },
      })
    )
    expect(result).toMatchObject({
      summary: "Triaged incident P1ABC; note posted",
      output: { status: "completed", incidentId: "P1ABC" },
    })
  })

  it("skips incidents below the configured minimum urgency", async () => {
    const { context, runCharacterTurn } = pluginContext(TRIAGE_DONE, JOB_OK)
    const run = runContext({
      config: { responderEmail: "oncall@acme.com", minUrgency: "high" },
      event: {
        ...runContext().event,
        payload: { incident: { id: "P9", urgency: "low" } },
      },
    })
    const result = await createIncidentResponder(context as never)(run as never)
    expect(result).toMatchObject({ output: { status: "skipped" } })
    expect(runCharacterTurn).not.toHaveBeenCalled()
  })

  it("returns early when the event carries no incident", async () => {
    const { context } = pluginContext(TRIAGE_DONE, JOB_OK)
    const run = runContext({ event: { ...runContext().event, payload: {}, resource: undefined } })
    const result = await createIncidentResponder(context as never)(run as never)
    expect(result?.summary).toContain("nothing to triage")
  })

  it("surfaces tool denials instead of posting when the turn needs approval", async () => {
    const turn = {
      sessionId: "s1",
      status: "needs_approval",
      text: "",
      needsApproval: [{ requestId: "r1", toolName: "Bash", at: 1, reason: "denied" }],
    }
    const { context, executeAction } = pluginContext(turn, JOB_OK)
    const result = await createIncidentResponder(context as never)(runContext() as never)
    expect(result).toMatchObject({ output: { status: "needs_approval" } })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it("does not call the broker when the note is declined", async () => {
    const { context, executeAction } = pluginContext(TRIAGE_DONE, JOB_OK)
    const run = runContext()
    run.step.waitForApproval.mockResolvedValueOnce({
      outcome: "denied",
      decidedAt: 2,
    } as never)
    const result = await createIncidentResponder(context as never)(run as never)
    expect(result).toMatchObject({ output: { status: "denied" } })
    expect(executeAction).not.toHaveBeenCalled()
  })

  it("fails closed when no working directory resolved", async () => {
    const { context } = pluginContext(TRIAGE_DONE, JOB_OK)
    const run = runContext({ cwd: undefined })
    await expect(createIncidentResponder(context as never)(run as never)).rejects.toThrow(
      "working directory"
    )
  })

  it("propagates a failed broker job as a step failure", async () => {
    const { context } = pluginContext(TRIAGE_DONE, {
      id: "job-1",
      status: "failed",
      error: "boom",
    })
    await expect(createIncidentResponder(context as never)(runContext() as never)).rejects.toThrow(
      "boom"
    )
  })

  it("throws when invoked without activation", () => {
    expect(() => incidentResponder(runContext() as never)).toThrow("not active")
  })
})
