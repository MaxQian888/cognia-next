/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

// jsdom can't drive Radix Select portals — stub the shell to a native select
// whose <option>s come from the real SelectItem children (same approach as
// control-commands.test.tsx, generalized to arbitrary items).
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children?: React.ReactNode
  }) => (
    <select
      data-testid="native-select"
      value={value ?? ""}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children, ...rest }: { value: string; children?: React.ReactNode }) => (
    <option value={value} {...rest}>
      {children}
    </option>
  ),
}))

const mockTeams: Record<string, { id: string; name: string }> = {}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: { teams: typeof mockTeams }) => unknown) =>
    selector({ teams: mockTeams }),
}))

import { TeamPicker } from "./team-picker"

function setTeams(teams: Array<{ id: string; name: string }>): void {
  for (const k of Object.keys(mockTeams)) delete mockTeams[k]
  for (const t of teams) mockTeams[t.id] = t
}

describe("TeamPicker", () => {
  it("lists a None entry plus every team, sorted by name", () => {
    setTeams([
      { id: "t2", name: "Zeta" },
      { id: "t1", name: "Alpha" },
    ])
    render(<TeamPicker value={undefined} onChange={jest.fn()} />)
    const options = screen.getAllByRole("option").map((o) => o.textContent)
    expect(options[0]).toMatch(/none/i)
    expect(options.slice(1)).toEqual(["Alpha", "Zeta"])
  })

  it("emits the picked team id and undefined for the None entry", () => {
    setTeams([{ id: "t1", name: "Alpha" }])
    const onChange = jest.fn()
    render(<TeamPicker value={undefined} onChange={onChange} />)
    const select = screen.getByTestId("native-select")
    fireEvent.change(select, { target: { value: "t1" } })
    expect(onChange).toHaveBeenLastCalledWith("t1")
    fireEvent.change(select, { target: { value: "__none__" } })
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it("renders a bound-but-deleted team id as a visible missing entry", () => {
    setTeams([{ id: "t1", name: "Alpha" }])
    render(<TeamPicker value="ghost-team-id" onChange={jest.fn()} />)
    const options = screen.getAllByRole("option").map((o) => o.textContent)
    // The missing entry keeps the stale id selectable so it can be cleared.
    expect(options.some((t) => t?.includes("missing"))).toBe(true)
    expect((screen.getByTestId("native-select") as HTMLSelectElement).value).toBe("ghost-team-id")
  })

  it("selects the bound team when it exists", () => {
    setTeams([{ id: "t1", name: "Alpha" }])
    render(<TeamPicker value="t1" onChange={jest.fn()} />)
    expect((screen.getByTestId("native-select") as HTMLSelectElement).value).toBe("t1")
    expect(screen.queryByText(/missing/)).toBeNull()
  })
})
