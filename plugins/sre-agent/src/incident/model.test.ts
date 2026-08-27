import type { SreTimelineRow, SreValidationResult } from "../evidence"
import {
  applyTimeline,
  applyValidation,
  attachEvidence,
  canConclude,
  compareIncidents,
  concludeIncident,
  confirmIncident,
  createIncident,
  createIncidentFromAlert,
  derivePhase,
  detachEvidence,
  dismissIncident,
  isPhaseComplete,
  phaseIndex,
  reopenIncident,
  setAgentRun,
  type SreIncident,
  type SreIncidentAlert,
} from "./model"

const NOW = "2026-08-04T12:10:00.000Z"
const LATER = "2026-08-04T12:20:00.000Z"
const WINDOW = { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" }

function base(overrides: Partial<SreIncident> = {}): SreIncident {
  return {
    ...createIncident({
      id: "inc_1",
      now: NOW,
      title: "gateway upstream timeout",
      environment: "prod",
      window: WINDOW,
      services: ["gateway", "gateway", " "],
    }),
    ...overrides,
  }
}

const ROW: SreTimelineRow = {
  time: "12:02:54",
  component: "gateway",
  event: "provider timeout",
  signals: ["timeout"],
  evidenceIds: ["log_003"],
  sources: ["logs"],
  confidence: 0.9,
  flags: ["timeout"],
}

const PASS: SreValidationResult = { ok: true, issues: [], evidenceCount: 3 }
const FAIL: SreValidationResult = {
  ok: false,
  issues: [{ code: "row.evidence_unknown", message: "cites unknown evidence", rowIndex: 0 }],
  evidenceCount: 3,
}

describe("createIncident", () => {
  it("opens straight into an investigation and dedupes services", () => {
    const incident = base()
    expect(incident).toMatchObject({
      status: "investigating",
      severity: "warning",
      services: ["gateway"],
      evidenceIds: [],
      timeline: [],
      validation: null,
    })
    expect(incident.agentRun).toEqual({ running: false, toolCalls: 0, maxTurns: 15 })
    expect(incident.createdAt).toBe(NOW)
    expect(incident.updatedAt).toBe(NOW)
  })

  it("honours an explicit turn budget and session scope", () => {
    const incident = createIncident({
      id: "inc_2",
      now: NOW,
      title: "t",
      environment: "prod",
      window: WINDOW,
      maxTurns: 30,
      sessionId: "sess_1",
    })
    expect(incident.agentRun.maxTurns).toBe(30)
    expect(incident.sessionId).toBe("sess_1")
  })
})

describe("createIncidentFromAlert", () => {
  const alert: SreIncidentAlert = {
    time: "2026-08-04T12:02:10.003Z",
    severity: "warning",
    service: "gateway",
    message: "gateway provider timeout and fallback increased",
    provider: "qwen-vllm-a",
    model: "qwen3-32b",
  }

  it("starts unconfirmed and widens the window backwards more than forwards", () => {
    const incident = createIncidentFromAlert(alert, {
      id: "inc_3",
      now: NOW,
      environment: "prod",
    })
    expect(incident.status).toBe("unconfirmed")
    expect(incident.title).toBe(alert.message)
    expect(incident.services).toEqual(["gateway"])
    expect(incident.window).toEqual({
      startTime: "2026-08-04T12:01:10.003Z",
      endTime: "2026-08-04T12:06:10.003Z",
    })
    expect(incident.alert).toEqual(alert)
  })

  it("anchors on `now` when the alert timestamp is unparseable", () => {
    const incident = createIncidentFromAlert(
      { ...alert, time: "not-a-time" },
      { id: "inc_4", now: NOW, environment: "prod" }
    )
    expect(incident.window).toEqual({
      startTime: "2026-08-04T12:09:00.000Z",
      endTime: "2026-08-04T12:14:00.000Z",
    })
  })

  it("carries correlation ids through when the alert has them", () => {
    const incident = createIncidentFromAlert(
      { ...alert, traceId: "9aa1", requestId: "req_1" },
      { id: "inc_5", now: NOW, environment: "prod" }
    )
    expect(incident).toMatchObject({ traceId: "9aa1", requestId: "req_1" })
  })
})

describe("derivePhase", () => {
  it("walks scope to conclusion as the incident fills up", () => {
    let incident = base()
    expect(derivePhase(incident)).toBe("scope")

    incident = attachEvidence(incident, ["log_003"], LATER)
    expect(derivePhase(incident)).toBe("evidence")

    incident = applyTimeline(incident, { rows: [ROW] }, LATER)
    expect(derivePhase(incident)).toBe("attribution")

    incident = concludeIncident(applyValidation(incident, PASS, LATER), LATER)
    expect(derivePhase(incident)).toBe("conclusion")
  })

  it("cannot claim attribution on an empty timeline even after evidence is unpinned", () => {
    const incident = detachEvidence(
      applyTimeline(attachEvidence(base(), ["log_003"], LATER), { rows: [] }, LATER),
      ["log_003"],
      LATER
    )
    expect(derivePhase(incident)).toBe("scope")
  })

  it("orders phases and reports which are behind", () => {
    const incident = attachEvidence(base(), ["log_003"], LATER)
    expect(phaseIndex("scope")).toBeLessThan(phaseIndex("conclusion"))
    expect(isPhaseComplete(incident, "scope")).toBe(true)
    expect(isPhaseComplete(incident, "evidence")).toBe(false)
    expect(isPhaseComplete(incident, "conclusion")).toBe(false)
  })
})

describe("status transitions", () => {
  it("confirms only an unconfirmed incident, and returns the same object otherwise", () => {
    const unconfirmed = base({ status: "unconfirmed" })
    expect(confirmIncident(unconfirmed, LATER)).toMatchObject({
      status: "investigating",
      updatedAt: LATER,
    })
    const investigating = base()
    expect(confirmIncident(investigating, LATER)).toBe(investigating)
  })

  it("dismisses once and keeps what was collected", () => {
    const incident = attachEvidence(base(), ["log_003"], LATER)
    const dismissed = dismissIncident(incident, LATER)
    expect(dismissed).toMatchObject({ status: "dismissed", evidenceIds: ["log_003"] })
    expect(dismissIncident(dismissed, LATER)).toBe(dismissed)
  })

  it("reopening clears the conclusion stamp so the phase falls back", () => {
    const concluded = concludeIncident(
      applyValidation(applyTimeline(base(), { rows: [ROW] }, LATER), PASS, LATER),
      LATER
    )
    expect(derivePhase(concluded)).toBe("conclusion")
    const reopened = reopenIncident(concluded, LATER)
    expect(reopened.concludedAt).toBeUndefined()
    expect(reopened.status).toBe("investigating")
    expect(derivePhase(reopened)).toBe("attribution")
    expect(reopenIncident(reopened, LATER)).toBe(reopened)
  })
})

describe("evidence", () => {
  it("preserves pin order, ignores repeats and blanks, and no-ops when nothing is new", () => {
    const once = attachEvidence(base(), ["log_003", "log_004", "log_003", "  "], LATER)
    expect(once.evidenceIds).toEqual(["log_003", "log_004"])
    expect(attachEvidence(once, ["log_003"], LATER)).toBe(once)
  })

  it("unpinning leaves a citing timeline row alone so validation reports it", () => {
    const withTimeline = applyTimeline(
      attachEvidence(base(), ["log_003"], LATER),
      { rows: [ROW] },
      LATER
    )
    const detached = detachEvidence(withTimeline, ["log_003"], LATER)
    expect(detached.evidenceIds).toEqual([])
    expect(detached.timeline[0].evidenceIds).toEqual(["log_003"])
    expect(detachEvidence(detached, ["log_003"], LATER)).toBe(detached)
  })
})

describe("timeline and validation", () => {
  it("stores findings and recommendations, defaulting both to empty", () => {
    const incident = applyTimeline(base(), { rows: [ROW] }, LATER)
    expect(incident).toMatchObject({ findings: [], recommendations: [] })

    const full = applyTimeline(
      incident,
      {
        rows: [ROW],
        findings: [{ text: "timeout preceded fallback", evidenceIds: ["log_003"] }],
        recommendations: [{ text: "check queue depth", evidenceIds: ["metric_002"] }],
      },
      LATER
    )
    expect(full.findings).toHaveLength(1)
    expect(full.recommendations).toHaveLength(1)
  })

  it("clears a stale verdict whenever the draft changes", () => {
    const validated = applyValidation(applyTimeline(base(), { rows: [ROW] }, LATER), PASS, LATER)
    expect(validated.validation).toEqual(PASS)
    const edited = applyTimeline(validated, { rows: [ROW, ROW] }, LATER)
    expect(edited.validation).toBeNull()
  })
})

describe("canConclude / concludeIncident", () => {
  it.each<[string, SreIncident, string]>([
    ["an empty timeline", base(), "timeline.empty"],
    ["an unchecked timeline", applyTimeline(base(), { rows: [ROW] }, LATER), "validation.missing"],
    [
      "a failed check",
      applyValidation(applyTimeline(base(), { rows: [ROW] }, LATER), FAIL, LATER),
      "validation.failed",
    ],
    ["a dismissed incident", dismissIncident(base(), LATER), "status.closed"],
  ])("refuses to conclude on %s", (_label, incident, blocker) => {
    expect(canConclude(incident)).toEqual({ ok: false, blocker })
    expect(() => concludeIncident(incident, LATER)).toThrow(blocker)
  })

  it("concludes a validated timeline and stamps the moment", () => {
    const ready = applyValidation(applyTimeline(base(), { rows: [ROW] }, LATER), PASS, LATER)
    expect(canConclude(ready)).toEqual({ ok: true })
    const concluded = concludeIncident(ready, LATER)
    expect(concluded).toMatchObject({ status: "resolved", concludedAt: LATER, updatedAt: LATER })
    expect(canConclude(concluded)).toEqual({ ok: false, blocker: "status.closed" })
  })
})

describe("setAgentRun", () => {
  it("patches only what it is given and stamps the incident", () => {
    const running = setAgentRun(base(), { running: true, toolCalls: 7, startedAt: NOW }, LATER)
    expect(running.agentRun).toEqual({
      running: true,
      toolCalls: 7,
      maxTurns: 15,
      startedAt: NOW,
    })
    const stopped = setAgentRun(running, { running: false, error: "aborted" }, LATER)
    expect(stopped.agentRun).toMatchObject({ running: false, toolCalls: 7, error: "aborted" })
  })
})

describe("compareIncidents", () => {
  it("puts open work first, then the most recently touched", () => {
    const rows: SreIncident[] = [
      base({ id: "d", status: "dismissed", updatedAt: LATER }),
      base({ id: "r", status: "resolved", updatedAt: LATER }),
      base({ id: "u", status: "unconfirmed", updatedAt: LATER }),
      base({ id: "i1", status: "investigating", updatedAt: NOW }),
      base({ id: "i2", status: "investigating", updatedAt: LATER }),
    ]
    expect([...rows].sort(compareIncidents).map((incident) => incident.id)).toEqual([
      "i2",
      "i1",
      "u",
      "r",
      "d",
    ])
  })
})
