/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

// Radix Select is exercised by its own suite; here a transparent mock exposes
// `onValueChange` and every rendered item so the picker's mapping is testable.
let lastOnValueChange: ((value: string) => void) | undefined
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children: React.ReactNode
    disabled?: boolean
  }) => {
    lastOnValueChange = onValueChange
    return (
      <div data-testid="select" data-value={value} data-disabled={disabled ? "true" : "false"}>
        {children}
      </div>
    )
  },
  SelectTrigger: ({ children, ...rest }: { children: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
  SelectValue: () => <span data-testid="select-value" />,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectLabel: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-group-label">{children}</div>
  ),
  SelectItem: ({ children, value, ...rest }: { children: React.ReactNode; value: string }) => (
    <div data-value={value} {...rest}>
      {children}
    </div>
  ),
}))

let characters: Array<{ id: string; name: string }> = []
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => characters }))
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn() }))

let teams: Record<string, { id: string; name: string; projectId?: string }> = {}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: { teams: typeof teams }) => unknown) => selector({ teams }),
}))
let activeProjectId: string | null = "w1"
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: { activeProjectId: string | null }) => unknown) =>
    selector({ activeProjectId }),
}))

import { render, screen } from "@testing-library/react"
import {
  AssigneePicker,
  UNASSIGNED_VALUE,
  actorForValue,
  buildAssigneeOptions,
} from "./assignee-picker"

beforeEach(() => {
  characters = [{ id: "c1", name: "Ada" }]
  teams = {
    t1: { id: "t1", name: "Squad", projectId: "w1" },
    t2: { id: "t2", name: "Elsewhere", projectId: "w2" },
    t3: { id: "t3", name: "Legacy" },
  }
  activeProjectId = "w1"
  lastOnValueChange = undefined
})

describe("buildAssigneeOptions / actorForValue", () => {
  it("lists me, Characters as agents and teams as squads, keyed by actorKey", () => {
    const options = buildAssigneeOptions(
      [{ id: "c1", name: "Ada" }],
      [{ id: "t1", name: "Squad" }],
      "Me"
    )
    expect(options.map((o) => [o.key, o.group, o.actor.label])).toEqual([
      ["human:self", "human", "Me"],
      ["agent:c1", "agent", "Ada"],
      ["team:t1", "team", "Squad"],
    ])
    expect(actorForValue(UNASSIGNED_VALUE, options)).toBeNull()
    expect(actorForValue("agent:c1", options)).toEqual({ kind: "agent", id: "c1", label: "Ada" })
    expect(actorForValue("agent:ghost", options)).toBeUndefined()
  })
})

describe("AssigneePicker", () => {
  it("offers Characters and this workspace's teams (plus legacy teams without a workspace)", () => {
    render(<AssigneePicker value={null} onChange={jest.fn()} />)
    expect(screen.getByTestId("issue-assignee-picker-none")).toBeInTheDocument()
    expect(screen.getByTestId("issue-assignee-picker-human:self")).toBeInTheDocument()
    expect(screen.getByTestId("issue-assignee-picker-agent:c1")).toHaveTextContent("Ada")
    expect(screen.getByTestId("issue-assignee-picker-team:t1")).toHaveTextContent("Squad")
    expect(screen.getByTestId("issue-assignee-picker-team:t3")).toHaveTextContent("Legacy")
    expect(screen.queryByTestId("issue-assignee-picker-team:t2")).not.toBeInTheDocument()
    expect(screen.getByTestId("select")).toHaveAttribute("data-value", UNASSIGNED_VALUE)
  })

  it("maps a selection back to an actor and clears on the sentinel", () => {
    const onChange = jest.fn()
    render(<AssigneePicker value={{ kind: "agent", id: "c1" }} onChange={onChange} />)
    expect(screen.getByTestId("select")).toHaveAttribute("data-value", "agent:c1")
    lastOnValueChange!("team:t1")
    expect(onChange).toHaveBeenLastCalledWith({ kind: "team", id: "t1", label: "Squad" })
    lastOnValueChange!(UNASSIGNED_VALUE)
    expect(onChange).toHaveBeenLastCalledWith(null)
    lastOnValueChange!("agent:unknown")
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("keeps a stale assignee visible so the control never renders blank", () => {
    render(
      <AssigneePicker
        value={{ kind: "agent", id: "gone", label: "Ghost" }}
        onChange={jest.fn()}
        disabled
        data-testid="picker"
      />
    )
    expect(screen.getByTestId("picker-stale")).toHaveTextContent("Ghost · assignee.missing")
    expect(screen.getByTestId("select")).toHaveAttribute("data-disabled", "true")
  })

  it("hides empty groups and tolerates no active workspace", () => {
    characters = []
    teams = {}
    activeProjectId = null
    render(<AssigneePicker value={null} onChange={jest.fn()} />)
    expect(screen.getAllByTestId("select-group-label")).toHaveLength(1)
  })
})
