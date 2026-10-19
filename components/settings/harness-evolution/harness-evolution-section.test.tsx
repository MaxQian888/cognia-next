/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

let mockStored: Record<string, unknown> | undefined
const mockSave = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { harnessEvolution: mockStored }, save: mockSave }),
}))
let mockServers: { id: string; name: string }[] | undefined = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockServers }))
jest.mock("./harness-role-model-picker", () => ({
  HarnessRoleModelPicker: ({
    role,
    onChange,
  }: {
    role: string
    onChange: (v: unknown) => void
  }) => (
    <button
      type="button"
      data-testid={`pick-${role}`}
      onClick={() => onChange(role === "editor" ? { providerId: "p", model: "m" } : undefined)}
    >
      {role}
    </button>
  ),
}))

import { HarnessEvolutionSection } from "./harness-evolution-section"

beforeEach(() => {
  mockStored = undefined
  mockSave.mockReset().mockResolvedValue(undefined)
  mockServers = [
    { id: "mcp-docs", name: "Docs" },
    { id: "mcp-db", name: "Database" },
  ]
})

describe("HarnessEvolutionSection", () => {
  it("is off by default and turns on through the flag", () => {
    render(<HarnessEvolutionSection />)
    expect(screen.getByRole("switch", { name: "Enable Harness Evolution" })).not.toBeChecked()
    expect(screen.getByText(/Probes never touch your workspace/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch", { name: "Enable Harness Evolution" }))
    expect(mockSave).toHaveBeenCalledWith({ harnessEvolution: { enabled: true } })
  })

  it("keeps the stored settings when changing one field", () => {
    mockStored = {
      enabled: true,
      startMode: "manual",
      budget: { maxTokens: 900_000 },
      models: { selector: { model: "x" } },
    }
    render(<HarnessEvolutionSection />)
    fireEvent.change(screen.getByLabelText("How runs may start"), {
      target: { value: "background" },
    })
    expect(mockSave).toHaveBeenLastCalledWith({
      harnessEvolution: { ...mockStored, startMode: "background" },
    })
    fireEvent.change(screen.getByLabelText("Recursion"), { target: { value: "sequential" } })
    expect(mockSave).toHaveBeenLastCalledWith({
      harnessEvolution: { ...mockStored, defaultMode: "sequential" },
    })
    fireEvent.click(screen.getByRole("switch", { name: "Auto-adopt low-risk improvements" }))
    expect(mockSave).toHaveBeenLastCalledWith({
      harnessEvolution: { ...mockStored, autoAdoptLowRisk: true },
    })
  })

  it("writes budget ceilings in their stored units", () => {
    mockStored = { enabled: true, budget: { maxTokens: 900_000 } }
    render(<HarnessEvolutionSection />)
    fireEvent.click(screen.getByText("Budget ceilings"))
    const minutes = screen.getByLabelText("Time (minutes)")
    expect(minutes).toHaveValue(120)
    fireEvent.change(minutes, { target: { value: "30" } })
    fireEvent.blur(minutes)
    expect(mockSave).toHaveBeenLastCalledWith({
      harnessEvolution: { enabled: true, budget: { maxTokens: 900_000, maxWallTimeMs: 1_800_000 } },
    })
  })

  it("sets and clears per-role models", () => {
    mockStored = { enabled: true, models: { selector: { model: "x" } } }
    render(<HarnessEvolutionSection />)
    fireEvent.click(screen.getByText("Models"))
    fireEvent.click(screen.getByTestId("pick-editor"))
    expect(mockSave).toHaveBeenLastCalledWith({
      harnessEvolution: {
        enabled: true,
        models: { selector: { model: "x" }, editor: { providerId: "p", model: "m" } },
      },
    })
    fireEvent.click(screen.getByTestId("pick-selector"))
    expect(mockSave).toHaveBeenLastCalledWith({ harnessEvolution: { enabled: true, models: {} } })
  })

  it("lets a person mark MCP servers safe for probes", () => {
    mockStored = { enabled: true, probeAllowedMcpServerIds: ["mcp-db"] }
    render(<HarnessEvolutionSection />)
    fireEvent.click(screen.getByText("What probes may reach"))
    fireEvent.click(screen.getByRole("checkbox", { name: "Docs" }))
    expect(mockSave).toHaveBeenLastCalledWith({
      harnessEvolution: { enabled: true, probeAllowedMcpServerIds: ["mcp-db", "mcp-docs"] },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "Database" }))
    expect(mockSave).toHaveBeenLastCalledWith({
      harnessEvolution: { enabled: true, probeAllowedMcpServerIds: [] },
    })
  })
})
