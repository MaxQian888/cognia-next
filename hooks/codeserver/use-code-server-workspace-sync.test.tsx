/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const mockTranslate = (key: string) => key
jest.mock("next-intl", () => ({
  useTranslations: () => mockTranslate,
}))

let issuesValue: unknown[] | undefined = []
let plansValue: unknown[] | undefined = []
let runsValue: unknown[] | undefined = []
let mockUseRealQueries = false
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (fn: () => unknown, deps: unknown[], initial: unknown) => {
    if (mockUseRealQueries) {
      return jest
        .requireActual("@/hooks/data/use-client-live-query")
        .useClientLiveQuery(fn, deps, initial)
    }
    const src = fn.toString()
    if (src.includes("listAllPlans")) return plansValue
    if (src.includes("listIssueRuns")) return runsValue
    return issuesValue
  },
}))
jest.mock("@/lib/db/issues", () => ({ listIssues: jest.fn() }))
jest.mock("@/lib/db/plans", () => ({ listAllPlans: jest.fn() }))
jest.mock("@/lib/db/issue-runs", () => ({ listIssueRuns: jest.fn() }))

const push = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { pushWorkspaceSnapshot: (...a: unknown[]) => push(...a) },
}))

let mockHost: object | null = null
let mockTransport: object = {}
const mockHostListeners = new Set<() => void>()
const mockTransportListeners = new Set<() => void>()
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => mockHost,
  subscribeActiveRemoteTransport: (listener: () => void) => {
    mockHostListeners.add(listener)
    return () => mockHostListeners.delete(listener)
  },
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  get transport() {
    return mockTransport
  },
  onTransportChange: (listener: () => void) => {
    mockTransportListeners.add(listener)
    return () => mockTransportListeners.delete(listener)
  },
}))

import { listIssues } from "@/lib/db/issues"
import { listAllPlans } from "@/lib/db/plans"
import { listIssueRuns } from "@/lib/db/issue-runs"

import { act, renderHook, waitFor } from "@testing-library/react"
import { useCodeServerWorkspaceSync } from "./use-code-server-workspace-sync"

const issue = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  identifier: "MERC-1",
  title: "Ship the board",
  description: "",
  status: "todo",
  updatedAt: 5,
  ...over,
})

beforeEach(() => {
  push.mockReset().mockResolvedValue(undefined)
  mockHost = null
  mockTransport = {}
  mockUseRealQueries = false
  issuesValue = [issue()]
  plansValue = []
  runsValue = []
})

it("pushes a snapshot once the pane is ready", () => {
  renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  expect(push).toHaveBeenCalledTimes(1)
  const [root, snapshot] = push.mock.calls[0]!
  expect(root).toBe("/repo")
  expect(snapshot.groups.map((g: { id: string }) => g.id)).toEqual(["issues", "plans", "runs"])
})

it("stays silent until the workbench is ready", () => {
  // Pushing before the companion extension has dialled back just fails.
  renderHook(() => useCodeServerWorkspaceSync(false, "/repo"))
  expect(push).not.toHaveBeenCalled()
})

it("does not re-push an identical snapshot", async () => {
  // The live queries re-fire on any write to the tables they touched, including
  // ones that change nothing this panel shows.
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  await act(async () => {})
  issuesValue = [issue()]
  rerender()
  issuesValue = [issue()]
  rerender()
  expect(push).toHaveBeenCalledTimes(1)
})

it("pushes again when the work actually changes", async () => {
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  issuesValue = [issue({ title: "Ship the board differently" })]
  rerender()
  await act(async () => {})
  expect(push).toHaveBeenCalledTimes(2)
})

it("carries a file target recovered from the issue text", () => {
  issuesValue = [issue({ title: "crash in lib/a.ts:42" })]
  renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  const [, snapshot] = push.mock.calls[0]!
  expect(snapshot.groups[0].rows[0]).toMatchObject({ path: "lib/a.ts", line: 42 })
})

it("retries after a failed push instead of latching the deduper", async () => {
  // Otherwise a push that failed while the workbench was booting would suppress
  // every identical snapshot afterwards, leaving the panel permanently empty.
  push.mockRejectedValueOnce(new Error("no extension connected"))
  jest.useFakeTimers()
  try {
    const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    await act(async () => {})
    rerender()
    expect(push).toHaveBeenCalledTimes(1)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})

it("sends the same data to a newly selected workspace", async () => {
  const { rerender } = renderHook(({ root }) => useCodeServerWorkspaceSync(true, root), {
    initialProps: { root: "/first" },
  })
  rerender({ root: "/second" })
  await act(async () => {})
  expect(push).toHaveBeenLastCalledWith("/second", expect.any(Object))
})

it("retries extension startup without a data change and cancels on unmount", async () => {
  jest.useFakeTimers()
  try {
    push.mockRejectedValueOnce(new Error("extension starting"))
    const { unmount } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})

it("coalesces a delayed burst into one latest full snapshot without concurrent writes", async () => {
  let finish!: () => void
  push.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  for (let revision = 1; revision <= 100; revision += 1) {
    issuesValue = [issue({ title: `Revision ${revision}` })]
    rerender()
  }
  expect(push).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish()
  })
  expect(push).toHaveBeenCalledTimes(2)
  expect(push.mock.calls[1][1].groups[0].rows[0].label).toBe("MERC-1 Revision 100")
  expect(push.mock.calls[1][1].groups.map((group: { id: string }) => group.id)).toEqual([
    "issues",
    "plans",
    "runs",
  ])
})

it("replays unchanged data after an extension restart or network recovery", async () => {
  jest.useFakeTimers()
  try {
    const { unmount } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    await act(async () => {})
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })
    expect(push).toHaveBeenCalledTimes(3)
    expect(push.mock.calls[2]).toEqual(push.mock.calls[0])
    unmount()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000)
    })
    expect(push).toHaveBeenCalledTimes(3)
  } finally {
    jest.useRealTimers()
  }
})

it("waits for an old scope write before publishing after disable and re-enable", async () => {
  let finish!: () => void
  push.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = renderHook(({ enabled }) => useCodeServerWorkspaceSync(enabled, "/repo"), {
    initialProps: { enabled: true },
  })
  rerender({ enabled: false })
  issuesValue = [issue({ title: "New session" })]
  rerender({ enabled: true })
  expect(push).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish()
  })
  expect(push).toHaveBeenCalledTimes(2)
  expect(push.mock.calls[1][1].groups[0].rows[0].label).toBe("MERC-1 New session")
})

it("bounds failure backoff and retries the latest full snapshot", async () => {
  jest.useFakeTimers()
  push.mockRejectedValue(new Error("host offline"))
  try {
    const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    await act(async () => {})
    const delays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
    for (const [index, delay] of delays.entries()) {
      issuesValue = [issue({ title: `Offline revision ${index}` })]
      rerender()
      await act(async () => {
        await jest.advanceTimersByTimeAsync(delay - 1)
      })
      expect(push).toHaveBeenCalledTimes(index + 1)
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1)
      })
      expect(push).toHaveBeenCalledTimes(index + 2)
    }
    push.mockResolvedValue(undefined)
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })
    expect(push.mock.calls.at(-1)[1].groups[0].rows[0].label).toBe("MERC-1 Offline revision 5")
  } finally {
    jest.useRealTimers()
  }
})

it("pauses while hidden or offline and restores only the newest data", async () => {
  jest.useFakeTimers()
  const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false)
  const online = jest.spyOn(navigator, "onLine", "get").mockReturnValue(true)
  try {
    const { rerender, unmount } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    await act(async () => {})
    hidden.mockReturnValue(true)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    issuesValue = [issue({ title: "Changed while hidden" })]
    rerender()
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000)
    })
    expect(push).toHaveBeenCalledTimes(1)
    online.mockReturnValue(false)
    hidden.mockReturnValue(false)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000)
    })
    expect(push).toHaveBeenCalledTimes(1)
    online.mockReturnValue(true)
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })
    expect(push).toHaveBeenCalledTimes(2)
    expect(push.mock.calls[1][1].groups[0].rows[0].label).toBe("MERC-1 Changed while hidden")
    online.mockReturnValue(false)
    act(() => {
      window.dispatchEvent(new Event("offline"))
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
    unmount()
    online.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    expect(push).toHaveBeenCalledTimes(2)
  } finally {
    hidden.mockRestore()
    online.mockRestore()
    jest.useRealTimers()
  }
})

it("does not dispatch queued data to a different remote host", async () => {
  let finish!: () => void
  push.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  issuesValue = [issue({ title: "Queued for original host" })]
  rerender()
  mockHost = { name: "other host" }
  await act(async () => {
    finish()
  })
  expect(push).toHaveBeenCalledTimes(1)
  // A fresh render creates data explicitly bound to the newly selected host.
  rerender()
  await act(async () => {})
  expect(push).toHaveBeenCalledTimes(2)
})

it("waits for all initial database queries instead of publishing empty defaults", () => {
  plansValue = undefined
  const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  expect(push).not.toHaveBeenCalled()
  plansValue = []
  runsValue = undefined
  rerender()
  expect(push).not.toHaveBeenCalled()
  runsValue = []
  issuesValue = undefined
  rerender()
  expect(push).not.toHaveBeenCalled()
  issuesValue = [issue()]
  rerender()
  expect(push).toHaveBeenCalledTimes(1)
})

it("keeps replay armed when an in-flight burst returns to the original data", async () => {
  jest.useFakeTimers()
  try {
    let finish!: () => void
    push.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const { rerender } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    issuesValue = [issue({ title: "Transient" })]
    rerender()
    issuesValue = [issue()]
    rerender()
    await act(async () => {
      finish()
    })
    expect(push).toHaveBeenCalledTimes(1)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000)
    })
    expect(push).toHaveBeenCalledTimes(2)
  } finally {
    jest.useRealTimers()
  }
})

it("does not retry a failed write after unmount", async () => {
  jest.useFakeTimers()
  try {
    let reject!: (error: Error) => void
    push.mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail
        })
    )
    const { unmount } = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    unmount()
    await act(async () => {
      reject(new Error("late disconnect"))
    })
    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000)
    })
    expect(push).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

it("preserves plan progress and run data in the coalesced snapshot", async () => {
  plansValue = [
    {
      id: "p1",
      title: "Plan",
      status: "executing",
      createdAt: 4,
      steps: [{ status: "completed" }, { status: "pending" }],
    },
  ]
  runsValue = [{ id: "r1", adapterId: "adapter", status: "running" }]
  renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  await act(async () => {})
  expect(push.mock.calls[0][1].groups[1].rows[0].description).toBe("1/2 · executing")
  expect(push.mock.calls[0][1].groups[2].rows[0].label).toBe("adapter")
})

it("waits for actual asynchronous live queries to hydrate all three tables", async () => {
  mockUseRealQueries = true
  let finishIssues!: (rows: unknown[]) => void
  let finishPlans!: (rows: unknown[]) => void
  let finishRuns!: (rows: unknown[]) => void
  ;(listIssues as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      finishIssues = resolve
    })
  )
  ;(listAllPlans as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      finishPlans = resolve
    })
  )
  ;(listIssueRuns as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      finishRuns = resolve
    })
  )
  renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  await waitFor(() => expect(listIssueRuns).toHaveBeenCalled())
  await act(async () => {
    finishIssues([issue()])
  })
  expect(push).not.toHaveBeenCalled()
  await act(async () => {
    finishPlans([])
  })
  expect(push).not.toHaveBeenCalled()
  await act(async () => {
    finishRuns([])
  })
  await waitFor(() => expect(push).toHaveBeenCalledTimes(1))
  expect(push.mock.calls[0][1].groups[0].rows[0].label).toBe("MERC-1 Ship the board")
})

it("drops a browser retry after the paired transport instance changes", async () => {
  jest.useFakeTimers()
  try {
    push.mockRejectedValueOnce(new Error("offline"))
    renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    await act(async () => {})
    mockTransport = { name: "new browser pairing" }
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000)
    })
    expect(push).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event("online"))
    })
    expect(push).toHaveBeenCalledTimes(1)
  } finally {
    jest.useRealTimers()
  }
})

it.each(["remote", "browser"])(
  "rebinds identical data on a %s transport notification",
  async (kind) => {
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useCodeServerWorkspaceSync(enabled, "/repo"),
      {
        initialProps: { enabled: true },
      }
    )
    await act(async () => {})
    await act(async () => {
      if (kind === "remote") {
        mockHost = { name: "new remote" }
        mockHostListeners.forEach((listener) => listener())
      } else {
        mockTransport = { name: "new browser pairing" }
        mockTransportListeners.forEach((listener) => listener())
      }
    })
    expect(push).toHaveBeenCalledTimes(2)
    expect(push.mock.calls[1]).toEqual(push.mock.calls[0])
    rerender({ enabled: false })
    await act(async () => {
      mockHost = null
      mockTransport = {}
      mockHostListeners.forEach((listener) => listener())
      mockTransportListeners.forEach((listener) => listener())
    })
    expect(push).toHaveBeenCalledTimes(2)
    unmount()
    expect(mockHostListeners.size).toBe(0)
    expect(mockTransportListeners.size).toBe(0)
  }
)

it("serializes a real unmount and remount of the same host and root", async () => {
  let finish!: () => void
  push.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const first = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  first.unmount()
  issuesValue = [issue({ title: "New mount" })]
  renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
  await act(async () => {})
  expect(push).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish()
  })
  expect(push).toHaveBeenCalledTimes(2)
  expect(push.mock.calls[1][1].groups[0].rows[0].label).toBe("MERC-1 New mount")
})

it("does not hold another workspace behind an unrelated pending command", async () => {
  let finish!: () => void
  push.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  renderHook(() => useCodeServerWorkspaceSync(true, "/first"))
  renderHook(() => useCodeServerWorkspaceSync(true, "/second"))
  expect(push).toHaveBeenCalledTimes(2)
  expect(push.mock.calls[1][0]).toBe("/second")
  await act(async () => {
    finish()
  })
})

it("keeps a cross-mount queued snapshot paused if the document becomes hidden", async () => {
  const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false)
  try {
    let finish!: () => void
    push.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const first = renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    first.unmount()
    issuesValue = [issue({ title: "New mount" })]
    renderHook(() => useCodeServerWorkspaceSync(true, "/repo"))
    hidden.mockReturnValue(true)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await act(async () => {
      finish()
    })
    expect(push).toHaveBeenCalledTimes(1)
    hidden.mockReturnValue(false)
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(push).toHaveBeenCalledTimes(2)
    expect(push.mock.calls[1][1].groups[0].rows[0].label).toBe("MERC-1 New mount")
  } finally {
    hidden.mockRestore()
  }
})
