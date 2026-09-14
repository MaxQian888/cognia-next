import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const liveQueryResults: Record<string, unknown> = {}
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    const key = fn.toString()
    for (const [needle, value] of Object.entries(liveQueryResults)) {
      if (key.includes(needle)) return value
    }
    return undefined
  },
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
const getSettings = jest.fn()
jest.mock("@/lib/db/settings", () => ({ getSettings: () => getSettings() }))
jest.mock("../../backup-schedule-dialog", () => ({
  BackupScheduleDialog: ({ onScheduled }: { onScheduled?: () => void }) => (
    <button data-testid="backup-dialog" onClick={() => onScheduled?.()} />
  ),
}))
const findSession = jest.fn()
jest.mock("@/lib/connectors/session-bindings", () => ({
  findActiveSessionForConversation: (key: string) => findSession(key),
}))
const setActiveSession = jest.fn()
const setSelectedGuild = jest.fn()
jest.mock("@/stores/chat", () => ({ useChatStore: { getState: () => ({ setActiveSession }) } }))
jest.mock("@/stores/ui", () => ({ useUIStore: { getState: () => ({ setSelectedGuild }) } }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"
import { KindFactsSection, kindHasFacts } from "./kind-facts-section"
import type { ScheduledTask } from "@/types/scheduler"
import type { SystemTask } from "@/types/scheduler/system-scheduler"
import type { UnifiedScheduledItem } from "@/types/scheduler/unified"

function item(kind: UnifiedScheduledItem["kind"], sourceId = "x"): UnifiedScheduledItem {
  return {
    unifiedId: `${kind}:${sourceId}`,
    kind,
    sourceId,
    name: sourceId,
    status: "active",
    triggerSummary: { type: "cron" },
    origin: { deepLinkHref: "/scheduler" },
    capabilities: { runNow: true, pause: true, edit: true, delete: true },
  }
}

beforeEach(() => {
  for (const key of Object.keys(liveQueryResults)) delete liveQueryResults[key]
  getSettings.mockReset()
  findSession.mockReset()
})

describe("KindFactsSection", () => {
  it("has facts for every kind but app", () => {
    expect(kindHasFacts(item("app"))).toBe(false)
    expect(kindHasFacts(item("workflow"))).toBe(true)
    const { container } = render(<KindFactsSection item={item("app")} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("resolves the workflow's name for a trigger", () => {
    liveQueryResults["workflowTriggers"] = {
      id: "t",
      workflowId: "w1",
      kind: "trigger.cron",
      enabled: true,
      webhookPath: "/hook",
    }
    liveQueryResults["workflows.get"] = { name: "Deploy" }
    render(<KindFactsSection item={item("workflow", "t")} />)
    expect(screen.getByText("Deploy")).toBeInTheDocument()
    expect(screen.getByText("/hook")).toBeInTheDocument()
    expect(screen.getByText(/^yes$/i)).toBeInTheDocument()
  })

  it("says when the workflow trigger is gone", () => {
    render(<KindFactsSection item={item("workflow", "t")} />)
    expect(screen.getByText("Workflow trigger not found.")).toBeInTheDocument()
  })

  it("reads the backup schedule and re-reads after the dialog saves", async () => {
    getSettings
      .mockResolvedValueOnce({
        backupAutoSchedule: { enabled: true, intervalDays: 3, dirPath: "/b", retainCount: 5 },
      })
      .mockResolvedValueOnce({
        backupAutoSchedule: { enabled: false, intervalDays: 7, dirPath: "/c", retainCount: 2 },
      })
    const onBackupScheduled = jest.fn()
    render(<KindFactsSection item={item("backup")} onBackupScheduled={onBackupScheduled} />)
    await waitFor(() => expect(screen.getByText("/b")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("backup-dialog"))
    expect(onBackupScheduled).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText("/c")).toBeInTheDocument())
  })

  it("shows a plugin job's handler and args from its task row", () => {
    const task = {
      payload: { pluginId: "p1", handler: "sync", args: { a: 1 } },
    } as unknown as ScheduledTask
    render(<KindFactsSection item={item("plugin")} task={task} />)
    expect(screen.getByText("p1")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-args-block")).toHaveTextContent('"a": 1')
    const { container } = render(<KindFactsSection item={item("plugin")} />)
    expect(container).toHaveTextContent("Plugin job not found")
  })

  it("opens a digest's source conversation, and says when it is gone", async () => {
    const task = {
      payload: {
        adapterId: "lark",
        conversationKey: "chat:1",
        characterId: "c1",
        prompt: "Summarise",
      },
    } as unknown as ScheduledTask
    findSession.mockResolvedValueOnce({ id: "s9" }).mockResolvedValueOnce(null)
    render(<KindFactsSection item={item("connector", "d1")} task={task} />)
    expect(screen.getByTestId("digest-prompt-block")).toHaveTextContent("Summarise")
    fireEvent.click(screen.getByTestId("digest-open-conversation"))
    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith("s9"))
    expect(setSelectedGuild).toHaveBeenCalledWith({ kind: "dm" })
    fireEvent.click(screen.getByTestId("digest-open-conversation"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
  })

  it("reads the outbound queue depth and breaker for the queue rollup", () => {
    liveQueryResults["outboundQueue.count"] = 4
    liveQueryResults["connectorAudit"] = { lastOpen: 1_700_000_000_000, lastClose: undefined }
    render(<KindFactsSection item={item("connector", "outbound:queue")} />)
    expect(screen.getByText("4")).toBeInTheDocument()
    expect(screen.getByText("-")).toBeInTheDocument()
  })

  it("renders the OS record's platform facts", () => {
    const systemTask = {
      status: "enabled",
      trigger: { type: "cron", expression: "0 * * * *" },
      action: { type: "run_command", command: "/usr/bin/true" },
      run_level: "administrator",
      metadata_state: "full",
    } as unknown as SystemTask
    render(<KindFactsSection item={item("system")} systemTask={systemTask} />)
    expect(screen.getByText("cron: 0 * * * *")).toBeInTheDocument()
    expect(screen.getByText("/usr/bin/true")).toBeInTheDocument()
    expect(screen.getByText("Administrator")).toBeInTheDocument()
    const { container } = render(<KindFactsSection item={item("system")} />)
    expect(container).toHaveTextContent("not found")
  })
})
