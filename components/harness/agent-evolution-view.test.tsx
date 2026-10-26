/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { Character } from "@cognia/agent-config-types"
import type { HarnessEvolutionRun } from "@/types/harness/evolution"
import { makeRun, makeTask } from "@/lib/harness/test-fixtures"

let mockRuns: HarnessEvolutionRun[] | undefined = []
let mockSettings = { enabled: true, startMode: "manual" }
jest.mock("@/hooks/harness/use-harness-data", () => ({
  useHarnessRuns: () => mockRuns,
  useHarnessEvolutionSettings: () => mockSettings,
}))
let mockSidecar = true
jest.mock("@/hooks/use-host-profile", () => ({ useCapability: () => mockSidecar }))
jest.mock("@/hooks/use-runtime-snapshot", () => ({ useRuntimeSnapshot: () => ({}) }))
let mockHostOwned = false
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ hostOwnsSessionState: () => mockHostOwned }))

const probes: Record<string, Record<string, unknown>> = {}
// A function declaration (hoisted), read only at render time.
function mockProbe(name: string, props: Record<string, unknown>) {
  probes[name] = props
  return <div data-testid={`${name}-probe`} />
}
jest.mock("./harness-run-list", () => ({
  HarnessRunList: (p: Record<string, unknown>) => mockProbe("list", p),
}))
jest.mock("./harness-run-viewer", () => ({
  HarnessRunViewer: (p: Record<string, unknown>) => mockProbe("viewer", p),
}))
jest.mock("./harness-version-history", () => ({
  HarnessVersionHistory: (p: Record<string, unknown>) => mockProbe("versions", p),
}))
jest.mock("./harness-experience-library", () => ({
  HarnessExperienceLibrary: (p: Record<string, unknown>) => mockProbe("library", p),
}))
jest.mock("./harness-start-run-dialog", () => ({
  HarnessStartRunDialog: (props: Record<string, unknown>) => {
    probes.dialog = props
    return props.open ? <div data-testid="dialog-probe" /> : null
  },
}))

import { AgentEvolutionView } from "./agent-evolution-view"

const agent = {
  id: "agent-1",
  name: "Analyst",
  harness: { adoptedSnapshotId: "snap-7" },
} as unknown as Character

beforeEach(() => {
  mockRuns = [makeRun({ id: "r2", task: makeTask({ title: "B" }) }), makeRun({ id: "r1" })]
  mockSettings = { enabled: true, startMode: "manual" }
  mockSidecar = true
  mockHostOwned = false
  for (const k of Object.keys(probes)) delete probes[k]
})

describe("AgentEvolutionView", () => {
  it("shows the newest run beside the list and opens others", () => {
    render(<AgentEvolutionView agent={agent} editable />)
    expect(probes.viewer).toMatchObject({ runId: "r2" })
    act(() => (probes.list.onSelect as (id: string) => void)("r1"))
    expect(probes.viewer).toMatchObject({ runId: "r1" })
  })

  it("starts runs from the dialog and opens the started run", () => {
    render(<AgentEvolutionView agent={agent} editable initialRunId="r1" />)
    expect(probes.viewer).toMatchObject({ runId: "r1" })
    fireEvent.click(screen.getByTestId("harness-start-run"))
    expect(screen.getByTestId("dialog-probe")).toBeInTheDocument()
    expect(probes.dialog).toMatchObject({ agent })
  })

  it("routes a reflection's lesson to the library, focused", () => {
    render(<AgentEvolutionView agent={agent} editable />)
    const openExperience = probes.viewer.onOpenExperience as (id: string) => void
    act(() => openExperience("exp-3"))
    expect(screen.getByTestId("library-probe")).toBeInTheDocument()
    expect(probes.library).toMatchObject({ characterId: "agent-1", focusId: "exp-3" })
  })

  it("passes the adopted version and write access to the history", () => {
    render(<AgentEvolutionView agent={agent} editable={false} />)
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Versions" }))
    fireEvent.click(screen.getByRole("tab", { name: "Versions" }))
    expect(probes.versions).toMatchObject({
      characterId: "agent-1",
      adoptedSnapshotId: "snap-7",
      editable: false,
    })
  })

  it.each([
    [() => (mockSettings = { enabled: false, startMode: "manual" }), "disabled"],
    [() => (mockHostOwned = true), "host-owned"],
    [() => (mockSidecar = false), "no-runtime"],
  ])("says why runs cannot start (%#)", (arrange, blocker) => {
    arrange()
    render(<AgentEvolutionView agent={agent} editable />)
    expect(screen.getByTestId("harness-blocker")).toHaveAttribute("data-blocker", blocker)
    expect(screen.getByTestId("harness-start-run")).toBeDisabled()
  })

  it("refuses agents on an external runtime", () => {
    render(
      <AgentEvolutionView
        agent={{ ...agent, runtime: { kind: "codex" } } as unknown as Character}
        editable
      />
    )
    expect(screen.getByTestId("harness-blocker")).toHaveAttribute("data-blocker", "external")
  })

  it("invites a first run", () => {
    mockRuns = []
    render(<AgentEvolutionView agent={agent} editable />)
    expect(screen.getByText("No runs yet")).toBeInTheDocument()
  })
})
