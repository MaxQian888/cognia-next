/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import { runPreflight } from "./lib/preflight"

jest.mock("next-intl", () => ({ useLocale: () => "en" }))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }))
jest.mock("./lib/preflight", () => ({
  runPreflight: jest.fn().mockResolvedValue({
    docker: true,
    strix: true,
    strixVersion: "0.1.3",
    checkedAt: 0,
  }),
}))
jest.mock("./lib/strix-runner", () => ({ runScan: jest.fn() }))
jest.mock("./db", () => ({
  getPref: jest.fn().mockResolvedValue(undefined),
  setPref: jest.fn(),
  deleteRun: jest.fn(),
  clearAllRuns: jest.fn(),
  listRuns: jest.fn().mockResolvedValue([]),
  listFindings: jest.fn().mockResolvedValue([]),
}))

let mockRuntime: {
  terminal: object
  dexie: object
  contextPanels?: { setBadge: jest.Mock } | null
} | null = null
jest.mock("./runtime", () => ({ peekStrixRuntime: () => mockRuntime }))

import type { ContextPanelRenderProps } from "@cognia/plugin-sdk"
import { StrixPanel } from "./StrixPanel"

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
})
