/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"

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

let mockRuntime: { terminal: object; dexie: object } | null = null
jest.mock("./runtime", () => ({ peekStrixRuntime: () => mockRuntime }))

import { StrixPanel } from "./StrixPanel"

describe("StrixPanel", () => {
  it("renders the unavailable state when the runtime is not wired", () => {
    mockRuntime = null
    render(<StrixPanel pluginId="strix-security" viewId="strix-panel" />)
    expect(screen.getByTestId("strix-unavailable")).toBeInTheDocument()
  })

  it("renders the panel + runs preflight when the runtime is wired", async () => {
    mockRuntime = { terminal: {}, dexie: {} }
    render(<StrixPanel pluginId="strix-security" viewId="strix-panel" />)
    expect(screen.getByTestId("strix-panel")).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId("strix-preflight-ok")).toBeInTheDocument())
  })
})
