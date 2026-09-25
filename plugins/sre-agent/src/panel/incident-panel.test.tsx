/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let bridge: {
  runtime: unknown
  dexie: unknown
  contextPanels: { setBadge: jest.Mock }
  confirm: jest.Mock
} | null = null
const activityListeners = new Set<(latest: unknown[]) => void>()
let activity: unknown[] = []

jest.mock("../panel-runtime", () => ({
  peekSrePanelRuntime: () => bridge,
  recentSreToolActivity: () => activity,
  subscribeSreToolActivity: (listener: (latest: unknown[]) => void) => {
    activityListeners.add(listener)
    return () => activityListeners.delete(listener)
  },
}))

import type { ContextPanelRenderProps } from "@cognia/plugin-sdk"
import type { SreIncident } from "../incident/model"
import { activityForIncident, IncidentPanel, unpinnedAgentEvidence } from "./incident-panel"
import { createIncident } from "../incident/model"
import { registerSreBundle, unregisterSreBundle } from "../i18n.test-helpers"

beforeEach(() => registerSreBundle())
afterEach(() => unregisterSreBundle())

const WINDOW = { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" }

const RESOURCE = {
  kind: "session" as const,
  sessionId: "sess_1",
  capabilities: [],
} as unknown as ContextPanelRenderProps["resource"]

function stubRuntime(overrides: Record<string, unknown> = {}) {
  return {
    provider: () => ({
      id: "qwen-timeout-fallback",
      kind: "fixture",
      demo: true,
      coverage: WINDOW,
    }),
    histogram: async () => [],
    patterns: async () => [],
    sources: async () => [],
    queryLogs: async ({ ids }: { ids?: string[] }) => ({
      ok: true,
      records: [],
      evidenceIds: ids ?? [],
      provider: "qwen-timeout-fallback",
      dataSource: "demo-corpus",
    }),
    resolveEvidenceIds: (ids: string[]) => ids,
    validateTimeline: async () => ({ ok: true, issues: [], evidenceCount: 1 }),
    ...overrides,
  }
}

function fakeDexie(rows: SreIncident[] = []) {
  const store = new Map(rows.map((row) => [row.id, row]))
  return {
    table: () => ({
      toArray: async () => [...store.values()],
      put: async (row: SreIncident) => {
        store.set(row.id, row)
      },
      get: async (id: string) => store.get(id),
      delete: async (id: string) => {
        store.delete(id)
      },
      clear: async () => store.clear(),
    }),
    store,
  }
}

function incident(overrides: Partial<SreIncident> = {}): SreIncident {
  return {
    ...createIncident({
      id: "inc_1",
      now: "2026-08-04T12:10:00.000Z",
      title: "gateway upstream timeout",
      environment: "prod",
      window: WINDOW,
      sessionId: "sess_1",
    }),
    ...overrides,
  }
}

function makeBridge(
  overrides: { runtime?: unknown; dexie?: unknown; confirm?: jest.Mock } = {}
): NonNullable<typeof bridge> {
  return {
    runtime: overrides.runtime ?? stubRuntime(),
    dexie: "dexie" in overrides ? overrides.dexie : fakeDexie(),
    contextPanels: { setBadge: jest.fn() },
    confirm: overrides.confirm ?? jest.fn(async () => true),
  }
}

function renderPanel(active = true) {
  return render(<IncidentPanel workbenchInstanceId="wb" resource={RESOURCE} active={active} />)
}

beforeEach(() => {
  bridge = null
  activity = []
  activityListeners.clear()
})

describe("activityForIncident / unpinnedAgentEvidence", () => {
  const opened = incident({ createdAt: "2026-08-04T12:10:00.000Z", evidenceIds: ["log_001"] })

  it("ignores activity that predates the incident", () => {
    const rows = [
      { tool: "sre_query_logs", evidenceIds: ["log_000"], at: "2026-08-04T12:09:00.000Z" },
      { tool: "sre_query_logs", evidenceIds: ["log_002"], at: "2026-08-04T12:11:00.000Z" },
    ]
    expect(activityForIncident(rows, opened)).toHaveLength(1)
    expect(unpinnedAgentEvidence(rows, opened)).toEqual(["log_002"])
  })

  it("dedupes and drops what is already pinned", () => {
    const rows = [
      {
        tool: "sre_query_logs",
        evidenceIds: ["log_001", "log_002"],
        at: "2026-08-04T12:11:00.000Z",
      },
      { tool: "sre_query_trace", evidenceIds: ["log_002"], at: "2026-08-04T12:12:00.000Z" },
    ]
    expect(unpinnedAgentEvidence(rows, opened)).toEqual(["log_002"])
  })
})

describe("IncidentPanel", () => {
  it("says the runtime is missing instead of rendering an empty investigation", () => {
    bridge = null
    renderPanel()
    expect(screen.getByTestId("sre-unavailable")).toBeInTheDocument()
  })

  it("warns that nothing will be saved when the shell gave it no storage", async () => {
    bridge = makeBridge({ dexie: null })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-panel")).toBeInTheDocument())
    expect(screen.getByText(/Incidents cannot be saved in this shell/)).toBeInTheDocument()
  })

  it("labels every view as the demo corpus while the demo backend answers", async () => {
    bridge = makeBridge({ dexie: fakeDexie([incident()]) })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    expect(screen.getByTestId("sre-demo-notice")).toHaveTextContent("Demo corpus")
    expect(screen.getByTestId("sre-demo-notice")).toHaveTextContent("not from your systems")
    await userEvent.click(screen.getByTestId("sre-incident-row"))
    expect(screen.getByTestId("sre-demo-notice")).toBeInTheDocument()
  })

  it("drops the demo label once a live backend answers", async () => {
    bridge = makeBridge({
      runtime: stubRuntime({
        provider: () => ({ id: "live", kind: "remote", demo: false, coverage: null }),
      }),
    })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-panel")).toBeInTheDocument())
    expect(screen.queryByTestId("sre-demo-notice")).not.toBeInTheDocument()
  })

  it("reports a failed load with a retry instead of an empty list", async () => {
    let fail = true
    const dexie = fakeDexie([incident()])
    const table = dexie.table()
    bridge = makeBridge({
      dexie: {
        table: () => ({
          ...table,
          toArray: async () => {
            if (fail) throw new Error("quota")
            return table.toArray()
          },
        }),
      },
    })
    renderPanel()
    await waitFor(() =>
      expect(screen.getByTestId("sre-load-error")).toHaveTextContent(
        "Incidents could not be loaded: quota"
      )
    )
    fail = false
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    expect(screen.queryByTestId("sre-load-error")).not.toBeInTheDocument()
  })

  it("lists stored incidents and opens the one that was clicked", async () => {
    bridge = makeBridge({ dexie: fakeDexie([incident()]) })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())

    await userEvent.click(screen.getByTestId("sre-incident-row"))
    expect(screen.getByTestId("sre-phase-strip")).toBeInTheDocument()
    expect(screen.getByTestId("sre-timeline")).toBeInTheDocument()
    // The full incident is readable, not just a truncated header.
    expect(screen.getByTestId("sre-incident-title")).toHaveTextContent("gateway upstream timeout")
    expect(screen.getByTestId("sre-incident-details")).toHaveTextContent("prod")
    expect(screen.getByTestId("sre-incident-details")).toHaveTextContent(WINDOW.startTime)
  })

  it("pushes the open-incident count onto its own rail button", async () => {
    bridge = makeBridge({
      dexie: fakeDexie([incident(), incident({ id: "inc_2", status: "resolved" })]),
    })
    renderPanel()
    await waitFor(() => expect(bridge?.contextPanels.setBadge).toHaveBeenCalledWith("incidents", 1))
  })

  it("opens an incident from what the person describes and persists it", async () => {
    const dexie = fakeDexie()
    bridge = makeBridge({ dexie })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-create-incident")).toBeInTheDocument())

    await userEvent.click(screen.getByTestId("sre-create-incident"))
    // An empty description is refused, not saved under a placeholder title.
    await userEvent.click(screen.getByTestId("sre-create-submit"))
    expect(screen.getByRole("alert")).toHaveTextContent("Describe the incident first.")
    expect(dexie.store.size).toBe(0)

    await userEvent.type(screen.getByTestId("sre-create-title"), "checkout p99 above 2s")
    await userEvent.clear(screen.getByTestId("sre-create-environment"))
    await userEvent.type(screen.getByTestId("sre-create-environment"), "staging")
    await userEvent.click(screen.getByTestId("sre-create-submit"))
    await waitFor(() => expect(screen.getByTestId("sre-phase-strip")).toBeInTheDocument())
    expect([...dexie.store.values()][0]).toMatchObject({
      sessionId: "sess_1",
      title: "checkout p99 above 2s",
      environment: "staging",
      window: WINDOW,
    })
    expect([...dexie.store.values()][0].demo).toBeUndefined()
  })

  it("opens the demo incident tagged as demo, never as a real page", async () => {
    const dexie = fakeDexie()
    bridge = makeBridge({ dexie })
    renderPanel()
    await userEvent.click(await screen.findByTestId("sre-create-from-alert"))
    await waitFor(() => expect(screen.getByTestId("sre-phase-strip")).toBeInTheDocument())
    const [stored] = [...dexie.store.values()]
    expect(stored).toMatchObject({ demo: true, status: "unconfirmed" })
    expect(screen.getByTestId("sre-incident-details")).toHaveTextContent(
      "gateway provider timeout and fallback increased"
    )
  })

  it("keeps 'New incident' reachable when incidents already exist", async () => {
    const dexie = fakeDexie([incident()])
    bridge = makeBridge({ dexie })
    renderPanel()
    await userEvent.click(await screen.findByTestId("sre-new-incident"))
    expect(screen.getByTestId("sre-create-form")).toBeInTheDocument()
    await userEvent.type(screen.getByTestId("sre-create-title"), "second one")
    await userEvent.click(screen.getByTestId("sre-create-submit"))
    await waitFor(() => expect(dexie.store.size).toBe(2))
  })

  it("fetches evidence before pinning it, so the validator can resolve the ids", async () => {
    const queryLogs = jest.fn(async ({ ids }: { ids?: string[] }) => ({
      ok: true,
      records: [],
      evidenceIds: (ids ?? []).filter((id) => id !== "log_gone"),
      provider: "qwen-timeout-fallback",
    }))
    activity = [
      {
        tool: "sre_query_logs",
        evidenceIds: ["log_003", "log_gone"],
        at: "2026-08-04T12:20:00.000Z",
      },
    ]
    const dexie = fakeDexie([incident()])
    bridge = makeBridge({ runtime: stubRuntime({ queryLogs }), dexie })
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-pin-agent-evidence"))

    await waitFor(() =>
      expect(queryLogs).toHaveBeenCalledWith(
        expect.objectContaining({ ids: ["log_003", "log_gone"] })
      )
    )
    // Only what the backend actually returned is pinned.
    await waitFor(() => expect(dexie.store.get("inc_1")?.evidenceIds).toEqual(["log_003"]))
  })

  it("pins trace and metric evidence already fetched by the agent", async () => {
    const queryLogs = jest.fn(async () => ({
      ok: true,
      records: [],
      evidenceIds: [],
      provider: "qwen-timeout-fallback",
    }))
    const resolveEvidenceIds = jest.fn((ids: string[]) => ids)
    activity = [
      {
        tool: "sre_query_trace",
        evidenceIds: ["span_002"],
        at: "2026-08-04T12:20:00.000Z",
      },
      {
        tool: "sre_query_metrics",
        evidenceIds: ["metric_001"],
        at: "2026-08-04T12:21:00.000Z",
      },
    ]
    const dexie = fakeDexie([incident()])
    bridge = makeBridge({ runtime: stubRuntime({ queryLogs, resolveEvidenceIds }), dexie })
    renderPanel()

    await userEvent.click(await screen.findByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-pin-agent-evidence"))

    await waitFor(() =>
      expect(dexie.store.get("inc_1")?.evidenceIds).toEqual(["span_002", "metric_001"])
    )
    expect(resolveEvidenceIds).toHaveBeenCalledWith(["span_002", "metric_001"])
    expect(queryLogs).not.toHaveBeenCalled()
  })

  it("lets the user apply the latest timeline drafted and validated by the agent", async () => {
    activity = [
      {
        tool: "sre_validate_timeline",
        evidenceIds: [],
        at: "2026-08-04T12:20:00.000Z",
        timelineDraft: {
          rows: [
            {
              time: "12:02:54.312",
              component: "gateway",
              event: "fallback",
              signals: ["fallback"],
              evidenceIds: ["log_004"],
              sources: ["logs"],
              confidence: 0.93,
              flags: ["fallback"],
            },
          ],
        },
        validation: { ok: true, issues: [], evidenceCount: 1 },
      },
    ]
    const dexie = fakeDexie([incident({ evidenceIds: ["log_004"] })])
    bridge = makeBridge({ dexie })
    renderPanel()

    await userEvent.click(await screen.findByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-apply-agent-timeline"))

    await waitFor(() => expect(dexie.store.get("inc_1")?.timeline).toHaveLength(1))
    expect(dexie.store.get("inc_1")?.validation?.ok).toBe(true)
  })

  it("reports agent activity honestly when there has been none", async () => {
    bridge = makeBridge({ dexie: fakeDexie([incident()]) })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-incident-row"))

    expect(screen.getByTestId("sre-agent-activity")).toHaveTextContent("No agent activity yet")
    expect(screen.queryByTestId("sre-pin-agent-evidence")).not.toBeInTheDocument()
  })

  it("offers dismiss on an open incident and reopen once it is closed", async () => {
    const dexie = fakeDexie([incident()])
    bridge = makeBridge({ dexie })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-incident-row"))

    await userEvent.click(screen.getByTestId("sre-dismiss"))
    await waitFor(() => expect(screen.getByTestId("sre-reopen")).toBeInTheDocument())
    expect(dexie.store.get("inc_1")?.status).toBe("dismissed")
  })

  it("deletes an incident only after a destructive confirmation", async () => {
    const dexie = fakeDexie([incident()])
    const confirm = jest.fn(async () => true)
    bridge = makeBridge({ dexie, confirm })
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-delete"))

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete this incident?",
        message: expect.stringContaining("gateway upstream timeout"),
        variant: "destructive",
      })
    )
    await waitFor(() => expect(screen.getByTestId("sre-incident-empty")).toBeInTheDocument())
    expect(dexie.store.size).toBe(0)
  })

  it("keeps the incident when the confirmation is declined", async () => {
    const dexie = fakeDexie([incident()])
    bridge = makeBridge({ dexie, confirm: jest.fn(async () => false) })
    renderPanel()
    await userEvent.click(await screen.findByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-delete"))
    await waitFor(() => expect(bridge?.confirm).toHaveBeenCalled())
    expect(screen.getByTestId("sre-phase-strip")).toBeInTheDocument()
    expect(dexie.store.size).toBe(1)
  })

  it("reports a failed delete and keeps the row", async () => {
    const dexie = fakeDexie([incident()])
    const table = dexie.table()
    bridge = makeBridge({
      dexie: {
        table: () => ({
          ...table,
          delete: async () => {
            throw new Error("locked")
          },
        }),
      },
    })
    renderPanel()
    await userEvent.click(await screen.findByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-delete"))
    await waitFor(() =>
      expect(screen.getByTestId("sre-action-error")).toHaveTextContent(
        "The incident could not be deleted: locked"
      )
    )
    expect(screen.getByTestId("sre-phase-strip")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss this message" }))
    expect(screen.queryByTestId("sre-action-error")).not.toBeInTheDocument()
  })

  it("reports a failed evidence fetch instead of swallowing it", async () => {
    activity = [
      { tool: "sre_query_logs", evidenceIds: ["log_003"], at: "2026-08-04T12:20:00.000Z" },
    ]
    bridge = makeBridge({
      runtime: stubRuntime({
        queryLogs: async () => {
          throw new Error("backend down")
        },
      }),
      dexie: fakeDexie([incident()]),
    })
    renderPanel()
    await userEvent.click(await screen.findByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-pin-agent-evidence"))
    await waitFor(() =>
      expect(screen.getByTestId("sre-action-error")).toHaveTextContent(
        "Evidence could not be pinned: backend down"
      )
    )
  })
})
