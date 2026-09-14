/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import { runPreflight } from "./lib/preflight"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))
// A functional useLiveQuery: run the querier and re-run it when deps change,
// so selection/triage tests see the same async data flow as the real hook.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps?: unknown[]) => {
    const React = jest.requireActual<typeof import("react")>("react")
    const { act } =
      jest.requireActual<typeof import("@testing-library/react")>("@testing-library/react")
    const [value, setValue] = React.useState<unknown>(undefined)
    React.useEffect(() => {
      let live = true
      Promise.resolve(querier()).then(
        (r) => {
          if (live) act(() => setValue(r))
        },
        () => undefined
      )
      return () => {
        live = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return value
  },
}))
// The real module also re-exports the host panel registry — pull in just the
// width hook so this suite stays component-level.
jest.mock("@cognia/plugin-sdk/api/context-panel", () => ({ useElementWidth: () => 0 }))
jest.mock("./lib/preflight", () => ({
  runPreflight: jest.fn().mockResolvedValue({
    docker: true,
    strix: true,
    strixVersion: "0.1.3",
    checkedAt: 0,
  }),
}))
jest.mock("./lib/strix-runner", () => ({
  runScan: jest.fn(),
  purgeAllArtifacts: jest.fn().mockResolvedValue(true),
  purgeRunArtifacts: jest.fn().mockResolvedValue(true),
}))
jest.mock("./db", () => ({
  getPref: jest.fn().mockResolvedValue(undefined),
  setPref: jest.fn().mockResolvedValue(undefined),
  deleteRun: jest.fn().mockResolvedValue(undefined),
  clearAllRuns: jest.fn().mockResolvedValue(undefined),
  listRuns: jest.fn().mockResolvedValue([]),
  listFindings: jest.fn().mockResolvedValue([]),
  listFindingStates: jest.fn().mockResolvedValue([]),
  listSuppressionRules: jest.fn().mockResolvedValue([]),
  setFindingState: jest.fn().mockResolvedValue(undefined),
  addSuppressionRule: jest.fn().mockResolvedValue(undefined),
  removeSuppressionRule: jest.fn().mockResolvedValue(undefined),
  suppressionRuleId: jest.fn((target: string, ruleId: string) => `${target}::${ruleId}`),
}))

let mockRuntime: {
  terminal: object
  dexie: object
  securityScans?: object
  ui?: { showToast: jest.Mock; showConfirmDialog: jest.Mock } | null
  contextPanels?: { setBadge: jest.Mock } | null
} | null = null
let mockPendingTarget: string | null = null
let mockActiveScan: { runId: string; controller: AbortController } | null = null
jest.mock("./runtime", () => ({
  peekStrixRuntime: () => mockRuntime,
  consumePendingTarget: () => {
    const target = mockPendingTarget
    mockPendingTarget = null
    return target
  },
  getActiveScan: () => mockActiveScan,
  setActiveScan: (runId: string, controller: AbortController) => {
    mockActiveScan = { runId, controller }
  },
  clearActiveScan: () => {
    mockActiveScan = null
  },
}))

import type { ContextPanelRenderProps } from "@cognia/plugin-sdk"
import { securityScanExecutionRunId } from "@cognia/plugin-sdk/api/security-findings"
import userEvent from "@testing-library/user-event"
import { fireEvent } from "@testing-library/react"
import {
  addSuppressionRule,
  clearAllRuns,
  deleteRun,
  listFindings,
  listRuns,
  listSuppressionRules,
  removeSuppressionRule,
  setFindingState,
  setPref,
} from "./db"
import { purgeAllArtifacts, purgeRunArtifacts, runScan } from "./lib/strix-runner"
import { StrixPanel } from "./StrixPanel"
import type { StrixFinding, StrixRun } from "./types"

/** The workbench hands a panel the resource in front, not plugin/view ids. */
const PANEL_PROPS = {
  workbenchInstanceId: "wb",
  resource: { kind: "session", sessionId: "sess_1", capabilities: [] },
  active: true,
} as unknown as ContextPanelRenderProps

describe("StrixPanel", () => {
  const mockedRunPreflight = jest.mocked(runPreflight)

  beforeEach(() => {
    mockRuntime = null
    mockPendingTarget = null
    mockActiveScan = null
    mockedRunPreflight.mockResolvedValue({
      docker: true,
      strix: true,
      strixVersion: "0.1.3",
      checkedAt: 0,
    })
  })

  it("renders the unavailable state when the runtime is not wired", () => {
    mockRuntime = null
    render(<StrixPanel {...PANEL_PROPS} />)
    expect(screen.getByTestId("strix-unavailable")).toBeInTheDocument()
  })

  it("does not draw a title bar of its own — the workbench header owns it", async () => {
    mockRuntime = { terminal: {}, dexie: {} }
    render(<StrixPanel {...PANEL_PROPS} />)
    await waitFor(() => expect(screen.getByTestId("strix-panel")).toBeInTheDocument())
    expect(screen.queryByText("Security")).not.toBeInTheDocument()
  })

  it("clears its rail badge while no scan is running", async () => {
    const setBadge = jest.fn()
    mockRuntime = { terminal: {}, dexie: {}, contextPanels: { setBadge } }
    render(<StrixPanel {...PANEL_PROPS} />)
    await waitFor(() => expect(setBadge).toHaveBeenCalledWith("security", 0))
  })

  it("survives a shell that refused the panel registration and has no badge sink", async () => {
    mockRuntime = { terminal: {}, dexie: {}, contextPanels: null }
    render(<StrixPanel {...PANEL_PROPS} />)
    await waitFor(() => expect(screen.getByTestId("strix-panel")).toBeInTheDocument())
  })

  it("renders the panel + runs preflight when the runtime is wired", async () => {
    mockRuntime = { terminal: {}, dexie: {} }
    render(<StrixPanel {...PANEL_PROPS} />)
    expect(screen.getByTestId("strix-panel")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("strix-preflight-ok")).toBeInTheDocument())
  })

  it("renders a blocked preflight when the terminal host connection is refused", async () => {
    mockedRunPreflight.mockRejectedValue(
      new Error(
        "ctx.terminal.spawn failed: terminal host socket connect failed: Connection refused (os error 61)"
      )
    )
    mockRuntime = { terminal: {}, dexie: {} }

    render(<StrixPanel {...PANEL_PROPS} />)

    await waitFor(() => expect(screen.getByTestId("strix-preflight-blocked")).toBeInTheDocument())
  })

  it("renders the form only after prefs resolve — defaults must land on first mount", async () => {
    mockRuntime = { terminal: {}, dexie: {} }
    render(<StrixPanel {...PANEL_PROPS} />)
    // getPref resolves on a microtask; until then the skeleton stands in.
    expect(screen.getByTestId("strix-form-loading")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("strix-target")).toBeInTheDocument())
  })

  it("prefills the target stashed by `/security <target>`", async () => {
    mockRuntime = { terminal: {}, dexie: {} }
    mockPendingTarget = "https://cmd.example"
    render(<StrixPanel {...PANEL_PROPS} />)
    await waitFor(() =>
      expect(screen.getByTestId("strix-target")).toHaveValue("https://cmd.example")
    )
    // One-shot: consumed.
    expect(mockPendingTarget).toBeNull()
  })
})

describe("StrixPanel scan lifecycle", () => {
  const mockedRunScan = jest.mocked(runScan)
  const mockedListRuns = jest.mocked(listRuns)
  const mockedListFindings = jest.mocked(listFindings)
  const mockedSetPref = jest.mocked(setPref)

  const run = (over: Partial<StrixRun> = {}): StrixRun => ({
    runId: "r1",
    target: "https://t.example",
    startedAt: 1_000,
    endedAt: 2_000,
    status: "done",
    findingsCount: 1,
    authorizedAt: 500,
    ...over,
  })

  const finding = (over: Partial<StrixFinding> = {}): StrixFinding => ({
    runId: "r1",
    vulnId: "v1",
    title: "SQL injection",
    severity: "high",
    fingerprint: "fp-1",
    ruleId: "sqli",
    ...over,
  })

  /** Runtime with the full desktop surface wired. */
  const fullRuntime = () => {
    const registerRunController = jest.fn(() => jest.fn())
    const syncExecutionRun = jest.fn().mockResolvedValue(undefined)
    const showToast = jest.fn()
    const showConfirmDialog = jest.fn().mockResolvedValue(true)
    const setBadge = jest.fn()
    mockRuntime = {
      terminal: {},
      dexie: {},
      securityScans: { registerRunController, syncExecutionRun },
      ui: { showToast, showConfirmDialog },
      contextPanels: { setBadge },
    }
    return { registerRunController, syncExecutionRun, showToast, showConfirmDialog, setBadge }
  }

  /** Fill the form far enough that the start button is enabled. */
  const armForm = async (
    user: ReturnType<typeof userEvent.setup>,
    target = "https://t.example"
  ) => {
    await waitFor(() => expect(screen.getByTestId("strix-preflight-ok")).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId("strix-target")).toBeInTheDocument())
    fireEvent.change(screen.getByTestId("strix-target"), { target: { value: target } })
    await user.click(screen.getByTestId("strix-authorized"))
  }

  beforeEach(() => {
    mockRuntime = null
    mockPendingTarget = null
    mockActiveScan = null
    jest.clearAllMocks()
    // clearAllMocks keeps mockResolvedValue implementations — re-pin the ones
    // individual tests override so nothing leaks between tests.
    mockedListRuns.mockResolvedValue([])
    mockedListFindings.mockResolvedValue([])
    jest.mocked(listSuppressionRules).mockResolvedValue([])
    mockedRunScan.mockResolvedValue(run())
  })

  it("streams a scan to the console, syncs the run journal, toasts, and saves prefs", async () => {
    const user = userEvent.setup()
    const { registerRunController, syncExecutionRun, showToast, setBadge } = fullRuntime()
    mockedRunScan.mockImplementation(async (_opts, deps) => {
      deps.onRun(run({ status: "running", endedAt: undefined }))
      deps.onConsole("strix is scanning…")
      deps.onRun(run({ status: "done", findingsCount: 2 }))
      return run({ status: "done", findingsCount: 2 })
    })

    render(<StrixPanel {...PANEL_PROPS} />)
    await armForm(user)
    await user.click(screen.getByTestId("strix-start"))

    await waitFor(() =>
      expect(syncExecutionRun).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "r1", status: "done" })
      )
    )
    // The scan's AbortController is handed to the host so the task cockpit can
    // cancel it — and released once the scan finishes.
    expect(registerRunController).toHaveBeenCalledWith(
      securityScanExecutionRunId("r1"),
      expect.any(AbortController)
    )
    expect(showToast).toHaveBeenCalledWith("Scan finished — 2 findings", "success")
    expect(mockedSetPref).toHaveBeenCalledWith(expect.anything(), "lastTarget", "https://t.example")
    expect(await screen.findByText(/strix is scanning/)).toBeInTheDocument()
    // Module handle released and the badge is back to idle.
    expect(mockActiveScan).toBeNull()
    await waitFor(() => expect(setBadge).toHaveBeenLastCalledWith("security", 0))
  })

  it("aborts an in-flight scan from the cancel button and frees the handle", async () => {
    const user = userEvent.setup()
    fullRuntime()
    // runScan never rejects — it turns an abort into a `cancelled` run row,
    // which is also what fires the cancellation toast.
    mockedRunScan.mockImplementation(
      (_opts, deps) =>
        new Promise<StrixRun>((resolve) => {
          deps.onRun?.(run({ status: "running", endedAt: undefined }))
          deps.signal?.addEventListener("abort", () => {
            const cancelled = run({ status: "cancelled" })
            deps.onRun?.(cancelled)
            resolve(cancelled)
          })
        })
    )

    render(<StrixPanel {...PANEL_PROPS} />)
    await armForm(user)
    await user.click(screen.getByTestId("strix-start"))
    await waitFor(() => expect(screen.getByTestId("strix-cancel")).toBeInTheDocument())

    await user.click(screen.getByTestId("strix-cancel"))
    await waitFor(() => expect(screen.getByTestId("strix-start")).toBeInTheDocument())
    expect(mockActiveScan).toBeNull()
  })

  it("keeps Cancel working for a scan a previous mount started", async () => {
    const user = userEvent.setup()
    fullRuntime()
    // Simulate the remount case: no local controller, but the module registry
    // still holds one for the running row.
    const controller = new AbortController()
    mockActiveScan = { runId: "r-live", controller }
    mockedListRuns.mockResolvedValue([
      run({ runId: "r-live", status: "running", endedAt: undefined }),
    ])

    render(<StrixPanel {...PANEL_PROPS} />)
    await waitFor(() => expect(screen.getByTestId("strix-cancel")).toBeInTheDocument())
    await user.click(screen.getByTestId("strix-cancel"))
    expect(controller.signal.aborted).toBe(true)
  })

  it("deletes a run's rows AND its on-disk artifacts after confirmation", async () => {
    const user = userEvent.setup()
    const { showConfirmDialog } = fullRuntime()
    mockedListRuns.mockResolvedValue([run()])
    render(<StrixPanel {...PANEL_PROPS} />)

    await user.click(await screen.findByRole("tab", { name: "History" }))
    await user.click(await screen.findByTestId("strix-history-delete"))

    await waitFor(() => expect(deleteRun).toHaveBeenCalledWith(expect.anything(), "r1"))
    expect(showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" })
    )
    expect(purgeRunArtifacts).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ terminal: expect.anything() })
    )
  })

  it("leaves everything alone when the delete confirmation is declined", async () => {
    const user = userEvent.setup()
    const { showConfirmDialog } = fullRuntime()
    showConfirmDialog.mockResolvedValue(false)
    mockedListRuns.mockResolvedValue([run()])
    render(<StrixPanel {...PANEL_PROPS} />)

    await user.click(await screen.findByRole("tab", { name: "History" }))
    await user.click(await screen.findByTestId("strix-history-delete"))
    await waitFor(() => expect(showConfirmDialog).toHaveBeenCalled())
    expect(deleteRun).not.toHaveBeenCalled()
    expect(purgeRunArtifacts).not.toHaveBeenCalled()
  })

  it("clear-all purges every artifact directory, not just the rows", async () => {
    const user = userEvent.setup()
    const { showConfirmDialog } = fullRuntime()
    mockedListRuns.mockResolvedValue([run()])
    render(<StrixPanel {...PANEL_PROPS} />)

    await user.click(await screen.findByRole("tab", { name: "History" }))
    await user.click(await screen.findByTestId("strix-clear-all"))

    await waitFor(() => expect(clearAllRuns).toHaveBeenCalled())
    expect(showConfirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" })
    )
    expect(purgeAllArtifacts).toHaveBeenCalled()
  })

  it("selecting a run shows its status banner and findings", async () => {
    const user = userEvent.setup()
    fullRuntime()
    mockedListRuns.mockResolvedValue([run({ status: "error", error: "docker died" })])
    mockedListFindings.mockResolvedValue([finding()])
    render(<StrixPanel {...PANEL_PROPS} />)

    await user.click(await screen.findByRole("tab", { name: "History" }))
    await user.click(await screen.findByTestId("strix-history-open"))

    await waitFor(() => expect(screen.getByTestId("strix-run-error")).toBeInTheDocument())
    expect(screen.getByText("docker died")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("strix-finding")).toBeInTheDocument())
    expect(screen.getByText("SQL injection")).toBeInTheDocument()
  })

  it("persists a triage verdict against the run's target, not the run", async () => {
    const user = userEvent.setup()
    fullRuntime()
    mockedListRuns.mockResolvedValue([run()])
    mockedListFindings.mockResolvedValue([finding()])
    render(<StrixPanel {...PANEL_PROPS} />)

    await user.click(await screen.findByRole("tab", { name: "History" }))
    await user.click(await screen.findByTestId("strix-history-open"))
    await waitFor(() => expect(screen.getByTestId("strix-finding-state")).toBeInTheDocument())

    await user.click(screen.getByTestId("strix-finding-state"))
    await user.click(await screen.findByRole("option", { name: "Risk accepted" }))
    await waitFor(() =>
      expect(setFindingState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          target: "https://t.example",
          fingerprint: "fp-1",
          state: "accepted",
        })
      )
    )
  })

  it("unmutes a rule class that a previous scan muted", async () => {
    const user = userEvent.setup()
    fullRuntime()
    mockedListRuns.mockResolvedValue([run()])
    mockedListFindings.mockResolvedValue([finding()])
    // A stored rule row is what turns the card's mute button into an unmute.
    jest.mocked(listSuppressionRules).mockResolvedValue([
      {
        id: "https://t.example::sqli",
        target: "https://t.example",
        ruleId: "sqli",
        createdAt: 1,
      },
    ])
    render(<StrixPanel {...PANEL_PROPS} />)

    await user.click(await screen.findByRole("tab", { name: "History" }))
    await user.click(await screen.findByTestId("strix-history-open"))
    await user.click(await screen.findByTestId("strix-rule-muted"))

    await waitFor(() =>
      expect(removeSuppressionRule).toHaveBeenCalledWith(
        expect.anything(),
        "https://t.example::sqli"
      )
    )
  })

  it("drops the head of the console once the stream crosses the cap", async () => {
    const user = userEvent.setup()
    fullRuntime()
    mockedRunScan.mockImplementation(async (_opts, deps) => {
      deps.onRun?.(run({ status: "running", endedAt: undefined }))
      // One burst bigger than the 200 KiB console cap.
      deps.onConsole?.("x".repeat(210 * 1024))
      const done = run({ status: "done" })
      deps.onRun?.(done)
      return done
    })
    render(<StrixPanel {...PANEL_PROPS} />)
    await armForm(user)
    await user.click(screen.getByTestId("strix-start"))

    await waitFor(() => expect(screen.getByTestId("strix-console-truncated")).toBeInTheDocument())
  })

  it("surfaces a scan error as a toast and an error banner on the run", async () => {
    const user = userEvent.setup()
    const { showToast } = fullRuntime()
    // The banner resolves the selected runId against the runs query — the row
    // must exist there, exactly as the runner's runs.put makes it in life.
    mockedListRuns.mockResolvedValue([run({ status: "error", error: "docker died" })])
    mockedRunScan.mockImplementation(async (_opts, deps) => {
      const failed = run({ status: "error", error: "docker died" })
      deps.onRun?.(run({ status: "running", endedAt: undefined }))
      deps.onRun?.(failed)
      return failed
    })
    render(<StrixPanel {...PANEL_PROPS} />)
    await armForm(user)
    await user.click(screen.getByTestId("strix-start"))

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Scan failed", "error"))
    await waitFor(() => expect(screen.getByTestId("strix-run-error")).toBeInTheDocument())
  })

  it("mutes a rule class through the finding card", async () => {
    const user = userEvent.setup()
    fullRuntime()
    mockedListRuns.mockResolvedValue([run()])
    mockedListFindings.mockResolvedValue([finding()])
    render(<StrixPanel {...PANEL_PROPS} />)

    await user.click(await screen.findByRole("tab", { name: "History" }))
    await user.click(await screen.findByTestId("strix-history-open"))
    await user.click(await screen.findByTestId("strix-suppress-rule"))

    await waitFor(() =>
      expect(addSuppressionRule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ target: "https://t.example", ruleId: "sqli" })
      )
    )
  })

  it("exports the selected run as SARIF without PoC payloads", async () => {
    const user = userEvent.setup()
    fullRuntime()
    mockedListRuns.mockResolvedValue([run()])
    mockedListFindings.mockResolvedValue([
      finding({ pocScriptCode: "exploit-print('boom')", technicalAnalysis: "poc details" }),
    ])
    const createObjectURL = jest.fn().mockReturnValue("blob:mock")
    const revokeObjectURL = jest.fn()
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    Object.assign(URL, { createObjectURL, revokeObjectURL })

    try {
      render(<StrixPanel {...PANEL_PROPS} />)
      await user.click(await screen.findByRole("tab", { name: "History" }))
      await user.click(await screen.findByTestId("strix-history-open"))
      await user.click(await screen.findByTestId("strix-export-sarif"))

      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
      const blob = createObjectURL.mock.calls[0][0] as Blob
      // jsdom's Blob predates Blob.text() — read it through a FileReader.
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(blob)
      })
      const log = JSON.parse(text)
      expect(log.version).toBe("2.1.0")
      const serialized = JSON.stringify(log)
      expect(serialized).not.toContain("exploit-print")
      expect(serialized).not.toContain("poc details")
    } finally {
      click.mockRestore()
      // @ts-expect-error restore jsdom's absent helpers
      delete URL.createObjectURL
      // @ts-expect-error restore jsdom's absent helpers
      delete URL.revokeObjectURL
    }
  })
})
