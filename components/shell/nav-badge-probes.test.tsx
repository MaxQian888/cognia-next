/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react"

let drafts: unknown[] = []
jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDrafts: () => drafts,
}))
let attention = 0
jest.mock("@/hooks/attention/use-attention", () => ({
  useAttentionCount: () => attention,
}))
let botsNeedingAttention = 0
const useBotInstallations = jest.fn(() => ({
  rows: [],
  loading: false,
  summary: { total: 0, armed: 0, needsAttention: botsNeedingAttention, deadLetters: 0 },
}))
jest.mock("@/hooks/bots/use-bot-installations", () => ({
  useBotInstallations: () => useBotInstallations(),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "tauri" }))

import { NavBadgeProbes } from "./nav-badge-probes"
import { __resetNavBadgesForTests, getNavBadgeSnapshot } from "@/lib/shell/nav-badges"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import {
  __resetApprovalRegistryForTesting,
  awaitApproval,
} from "@/lib/connectors/hitl/approval-registry"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/types/shell/sidebar"

const refreshAll = jest.fn(async () => {})

function setLayout(pinned: string[], hidden: string[]) {
  useSettingsStore.setState({ settings: { sidebarLayout: { pinned, hidden } } as never })
}

const failingTask = {
  id: "task-1",
  name: "Nightly",
  type: "prompt",
  status: "active",
  trigger: { type: "interval", intervalMs: 60_000 },
  consecutiveFailures: 3,
  lastError: "boom",
  successCount: 0,
  failureCount: 3,
  tags: [],
}

beforeEach(() => {
  __resetNavBadgesForTests()
  __resetApprovalRegistryForTesting()
  drafts = []
  attention = 0
  botsNeedingAttention = 0
  useBotInstallations.mockClear()
  setLayout(DEFAULT_SIDEBAR_LAYOUT.pinned, [])
  refreshAll.mockClear()
  // The store's own loader reaches Dexie / a paired host; the probe's job is
  // only to ask for it.
  useSchedulerStore.setState({ tasks: [], isInitialized: true, refreshAll })
})

describe("NavBadgeProbes", () => {
  it("reports each source under the destination it badges", () => {
    drafts = [{}, {}]
    attention = 3
    botsNeedingAttention = 1
    useSchedulerStore.setState({ tasks: [failingTask] as never })
    render(<NavBadgeProbes />)
    expect(getNavBadgeSnapshot()).toEqual({ inbox: 2, "agent-runs": 3, scheduler: 1, bots: 1 })
  })

  it("counts connector approvals waiting in an IM conversation toward Inbox, live", () => {
    render(<NavBadgeProbes />)
    expect(getNavBadgeSnapshot()).toEqual({})
    act(() => {
      void awaitApproval("s-1", "r-1").catch(() => undefined)
    })
    expect(getNavBadgeSnapshot()).toEqual({ inbox: 1 })
  })

  it("does not count a running or healthy scheduler task", () => {
    useSchedulerStore.setState({
      tasks: [{ ...failingTask, consecutiveFailures: 0, lastError: undefined }] as never,
    })
    render(<NavBadgeProbes />)
    expect(getNavBadgeSnapshot()).toEqual({})
  })

  it("stops sampling a destination once it is hidden, and its count goes with it", () => {
    botsNeedingAttention = 2
    const { rerender } = render(<NavBadgeProbes />)
    expect(getNavBadgeSnapshot()).toEqual({ bots: 2 })
    const calls = useBotInstallations.mock.calls.length
    act(() => setLayout(DEFAULT_SIDEBAR_LAYOUT.pinned, ["bots"]))
    rerender(<NavBadgeProbes />)
    expect(getNavBadgeSnapshot()).toEqual({})
    rerender(<NavBadgeProbes />)
    expect(useBotInstallations.mock.calls.length).toBe(calls)
  })

  it("reports zero for everything once unmounted", () => {
    drafts = [{}]
    attention = 1
    const { unmount } = render(<NavBadgeProbes />)
    unmount()
    expect(getNavBadgeSnapshot()).toEqual({})
  })

  it("loads the scheduler store when nothing has initialized it", () => {
    useSchedulerStore.setState({ isInitialized: false })
    render(<NavBadgeProbes />)
    expect(refreshAll).toHaveBeenCalledTimes(1)
  })

  it("leaves an initialized store to its owner", () => {
    render(<NavBadgeProbes />)
    expect(refreshAll).not.toHaveBeenCalled()
  })

  it("loads again when the owner stops the scheduler", () => {
    render(<NavBadgeProbes />)
    act(() => useSchedulerStore.setState({ isInitialized: false }))
    expect(refreshAll).toHaveBeenCalledTimes(1)
  })

  it("does not load the scheduler store while its destination is hidden", () => {
    useSchedulerStore.setState({ isInitialized: false })
    setLayout(DEFAULT_SIDEBAR_LAYOUT.pinned, ["scheduler"])
    render(<NavBadgeProbes />)
    expect(refreshAll).not.toHaveBeenCalled()
  })
})
