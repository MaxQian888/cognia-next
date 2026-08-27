/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))

let bridge: {
  runtime: unknown
  dexie: unknown
  contextPanels: { setBadge: jest.Mock } | null
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

import type { ContextPanelRenderProps } from "@/types/context-workbench"
import type { SreIncident } from "../incident/model"
import { activityForIncident, IncidentPanel, unpinnedAgentEvidence } from "./incident-panel"
import { createIncident } from "../incident/model"

const WINDOW = { startTime: "2026-08-04T12:02:00.000Z", endTime: "2026-08-04T12:05:20.000Z" }

const RESOURCE = {
  kind: "session" as const,
  sessionId: "sess_1",
  capabilities: [],
} as unknown as ContextPanelRenderProps["resource"]

function stubRuntime(overrides: Record<string, unknown> = {}) {
  return {
    provider: () => ({ id: "qwen-timeout-fallback", kind: "fixture", coverage: WINDOW }),
    histogram: async () => [],
    patterns: async () => [],
    sources: async () => [],
    queryLogs: async ({ ids }: { ids?: string[] }) => ({
      ok: true,
      records: [],
      evidenceIds: ids ?? [],
      provider: "qwen-timeout-fallback",
    }),
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
    bridge = { runtime: stubRuntime(), dexie: null, contextPanels: null }
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-panel")).toBeInTheDocument())
    expect(screen.getByText(/Incidents cannot be saved in this shell/)).toBeInTheDocument()
  })

  it("lists stored incidents and opens the one that was clicked", async () => {
    bridge = {
      runtime: stubRuntime(),
      dexie: fakeDexie([incident()]),
      contextPanels: { setBadge: jest.fn() },
    }
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())

    await userEvent.click(screen.getByTestId("sre-incident-row"))
    expect(screen.getByTestId("sre-phase-strip")).toBeInTheDocument()
    expect(screen.getByTestId("sre-timeline")).toBeInTheDocument()
  })

  it("pushes the open-incident count onto its own rail button", async () => {
    const setBadge = jest.fn()
    bridge = {
      runtime: stubRuntime(),
      dexie: fakeDexie([incident(), incident({ id: "inc_2", status: "resolved" })]),
      contextPanels: { setBadge },
    }
    renderPanel()
    await waitFor(() => expect(setBadge).toHaveBeenCalledWith("incidents", 1))
  })

  it("creates an incident from the session in front and persists it", async () => {
    const dexie = fakeDexie()
    bridge = { runtime: stubRuntime(), dexie, contextPanels: null }
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-create-incident")).toBeInTheDocument())

    await userEvent.click(screen.getByTestId("sre-create-incident"))
    await waitFor(() => expect(screen.getByTestId("sre-phase-strip")).toBeInTheDocument())
    expect([...dexie.store.values()][0]).toMatchObject({ sessionId: "sess_1" })
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
    bridge = { runtime: stubRuntime({ queryLogs }), dexie, contextPanels: null }
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

  it("reports agent activity honestly when there has been none", async () => {
    bridge = { runtime: stubRuntime(), dexie: fakeDexie([incident()]), contextPanels: null }
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-incident-row"))

    expect(screen.getByTestId("sre-agent-activity")).toHaveTextContent("No agent activity yet")
    expect(screen.queryByTestId("sre-pin-agent-evidence")).not.toBeInTheDocument()
  })

  it("offers dismiss on an open incident and reopen once it is closed", async () => {
    const dexie = fakeDexie([incident()])
    bridge = { runtime: stubRuntime(), dexie, contextPanels: null }
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-incident-row"))

    await userEvent.click(screen.getByTestId("sre-dismiss"))
    await waitFor(() => expect(screen.getByTestId("sre-reopen")).toBeInTheDocument())
    expect(dexie.store.get("inc_1")?.status).toBe("dismissed")
  })

  it("deletes an incident and returns to the list", async () => {
    const dexie = fakeDexie([incident()])
    bridge = { runtime: stubRuntime(), dexie, contextPanels: null }
    renderPanel()
    await waitFor(() => expect(screen.getByTestId("sre-incident-row")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("sre-incident-row"))
    await userEvent.click(screen.getByTestId("sre-delete"))

    await waitFor(() => expect(screen.getByTestId("sre-incident-empty")).toBeInTheDocument())
    expect(dexie.store.size).toBe(0)
  })
})
