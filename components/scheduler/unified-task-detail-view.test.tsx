/** @jest-environment node */

/**
 * Lightweight smoke test for the unified detail orchestrator. The full
 * render path pulls in Dexie + the scheduler subsystem transitively and
 * blows up the Jest worker heap even with sub-view mocks; the dispatch
 * logic is a simple switch already validated by the per-kind sub-view
 * tests. Here we verify the orchestrator module loads, exports the
 * expected symbol, and stays a function component.
 */

// Mock the heavyweight side of the import graph so simply requiring the
// orchestrator doesn't try to spin up Dexie or the scheduler stores.
jest.mock("./details/workflow-detail", () => ({ WorkflowDetail: () => null }))
jest.mock("./details/backup-detail", () => ({ BackupDetail: () => null }))
jest.mock("./details/plugin-detail", () => ({ PluginDetail: () => null }))
jest.mock("./details/connector-digest-detail", () => ({ ConnectorDigestDetail: () => null }))
jest.mock("./details/connector-queue-detail", () => ({ ConnectorQueueDetail: () => null }))
jest.mock("./system-task-inspect-sheet", () => ({
  SystemTaskInspectSheet: () => null,
  SystemTaskInspectBody: () => null,
}))
jest.mock("./task-detail-view", () => ({ TaskDetailView: () => null }))
jest.mock("@/lib/scheduler/sources/connector-source", () => ({
  CONNECTOR_QUEUE_SOURCE_ID: "outbound:queue",
}))
jest.mock("@/hooks/scheduler/use-system-scheduler", () => ({
  useSystemScheduler: () => ({ tasks: [] }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Top-level import (replaces the previous require() call) — eslint forbids
// require() style imports project-wide.
import * as mod from "./unified-task-detail-view"

describe("UnifiedTaskDetailView module", () => {
  it("exports a function component named UnifiedTaskDetailView", () => {
    expect(typeof mod.UnifiedTaskDetailView).toBe("function")
  })
})
