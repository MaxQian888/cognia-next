/**
 * @jest-environment jsdom
 */

import { fireEvent, render, renderHook, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"

jest.mock("@/components/ui/dropdown-menu")

const mockCharacters = jest.fn(() => [] as Array<{ id: string; name: string }>)
jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => mockCharacters() }))

const mockLabels = jest.fn(
  () => [] as Array<{ id: string; name: string; color?: string; scope: string; sortOrder: number }>
)
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => mockLabels(),
}))

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { MenuKit, MenuKitItemProps } from "@/components/shared/menu-kit"
import {
  AssigneeMenuItems,
  LabelMenuItems,
  SnoozeMenuItems,
  StatusMenuItems,
  TRIAGE_DROPDOWN_KIT,
  useAssigneeLabel,
  type TriageMenuKit,
} from "./triage-menu-items"

/** A kit of plain elements, like the phone sheet (no checkbox item). */
const PLAIN_KIT: TriageMenuKit = {
  Item: ({
    children,
    onSelect,
    "aria-current": current,
    "data-testid": testId,
  }: MenuKitItemProps) => (
    <button
      type="button"
      aria-current={current}
      data-testid={testId}
      onClick={() => onSelect?.(new Event("select"))}
    >
      {children}
    </button>
  ),
  Label: ({ children }: { children?: ReactNode }) => <p data-testid="plain-label">{children}</p>,
  Separator: () => <hr />,
  Sub: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SubTrigger: ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode
    "data-testid"?: string
  }) => <span data-testid={testId}>{children}</span>,
  SubContent: ({ children }: { children?: ReactNode }) => (
    <div data-testid="plain-sub">{children}</div>
  ),
  Shortcut: () => null,
  Heading: ({ children }: { children?: ReactNode }) => <h4>{children}</h4>,
}

beforeEach(() => {
  mockCharacters.mockReturnValue([])
  mockLabels.mockReturnValue([])
  useAgentTeamStore.setState({ teams: {} } as never)
})

describe("StatusMenuItems", () => {
  it("offers open, pending, a snooze submenu and resolved, marking the current one", () => {
    const onSetStatus = jest.fn()
    render(
      <StatusMenuItems
        kit={TRIAGE_DROPDOWN_KIT}
        current="pending"
        onSetStatus={onSetStatus}
        now={() => 1_000}
      />
    )
    expect(screen.getByTestId("triage-status-pending")).toHaveAttribute("aria-current", "true")
    expect(screen.getByTestId("triage-status-open")).not.toHaveAttribute("aria-current")
    fireEvent.click(screen.getByTestId("triage-status-resolved"))
    expect(onSetStatus).toHaveBeenCalledWith("resolved")
    fireEvent.click(screen.getByTestId("triage-snooze-8h"))
    expect(onSetStatus).toHaveBeenLastCalledWith("snoozed", 1_000 + 8 * 3_600_000)
  })

  it("can leave snooze out (the row menu has its own)", () => {
    render(<StatusMenuItems kit={PLAIN_KIT} onSetStatus={jest.fn()} includeSnooze={false} />)
    expect(screen.queryByTestId("triage-status-snoozed")).not.toBeInTheDocument()
    expect(screen.getByText("Open")).toBeInTheDocument()
  })
})

describe("SnoozeMenuItems", () => {
  it("snoozes for a preset from the given clock", () => {
    const onSnooze = jest.fn()
    render(<SnoozeMenuItems kit={PLAIN_KIT} onSnooze={onSnooze} now={() => 500} />)
    fireEvent.click(screen.getByText("Snooze 1 hour"))
    expect(onSnooze).toHaveBeenCalledWith("1h", 500 + 3_600_000)
    expect(screen.queryByTestId("triage-snooze-wake")).not.toBeInTheDocument()
  })

  it("offers Wake now only while snoozed", () => {
    const onWake = jest.fn()
    render(<SnoozeMenuItems kit={PLAIN_KIT} onSnooze={jest.fn()} snoozed onWake={onWake} />)
    fireEvent.click(screen.getByTestId("triage-snooze-wake"))
    expect(onWake).toHaveBeenCalled()
  })
})

describe("AssigneeMenuItems", () => {
  it("lists me, characters, teams (sorted) and unassign under their headings", () => {
    mockCharacters.mockReturnValue([{ id: "c1", name: "Ava" }])
    useAgentTeamStore.setState({
      teams: { t2: { id: "t2", name: "Zed" }, t1: { id: "t1", name: "Alpha" } },
    } as never)
    const onAssign = jest.fn()
    render(
      <AssigneeMenuItems
        kit={PLAIN_KIT}
        current={{ kind: "team", id: "t1" }}
        onAssign={onAssign}
        routingNote
      />
    )
    expect(screen.getByRole("heading", { name: "Character" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Team" })).toBeInTheDocument()
    expect(screen.getAllByTestId(/assignee-team-/).map((el) => el.textContent)).toEqual([
      "Alpha",
      "Zed",
    ])
    expect(screen.getByTestId("assignee-team-t1")).toHaveAttribute("aria-current", "true")
    expect(screen.getByText(/Assigning also syncs routing/)).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("assignee-me"))
    expect(onAssign).toHaveBeenCalledWith({ kind: "human" })
    fireEvent.click(screen.getByTestId("assignee-character-c1"))
    expect(onAssign).toHaveBeenLastCalledWith({ kind: "character", id: "c1", label: "Ava" })
    fireEvent.click(screen.getByTestId("assignee-unassign"))
    expect(onAssign).toHaveBeenLastCalledWith(null)
  })

  it("marks nothing current when the targets disagree", () => {
    render(<AssigneeMenuItems kit={PLAIN_KIT} current={undefined} onAssign={jest.fn()} />)
    expect(screen.getByTestId("assignee-me")).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("assignee-unassign")).not.toHaveAttribute("aria-current")
  })

  it("marks Unassign current for an unassigned conversation", () => {
    render(<AssigneeMenuItems kit={PLAIN_KIT} current={null} onAssign={jest.fn()} />)
    expect(screen.getByTestId("assignee-unassign")).toHaveAttribute("aria-current", "true")
  })
})

describe("LabelMenuItems", () => {
  const labels = [
    { id: "l1", name: "VIP", color: "#f00", scope: "conversation", sortOrder: 0 },
    { id: "l2", name: "Bug", scope: "conversation", sortOrder: 1 },
    { id: "l3", name: "Lead", scope: "conversation", sortOrder: 2 },
  ]

  it("draws tri-state checkbox items and reports the state toggled", () => {
    mockLabels.mockReturnValue(labels)
    const onToggle = jest.fn()
    const onManage = jest.fn()
    render(
      <LabelMenuItems
        kit={TRIAGE_DROPDOWN_KIT}
        stateOf={(id) => (id === "l1" ? "checked" : id === "l2" ? "mixed" : "unchecked")}
        onToggle={onToggle}
        onManage={onManage}
      />
    )
    expect(screen.getByTestId("triage-label-l1")).toHaveAttribute("aria-checked", "true")
    expect(screen.getByTestId("triage-label-l2")).toHaveAttribute("aria-checked", "indeterminate")
    // "Some of them": a minus glyph instead of Radix's check.
    expect(screen.getByTestId("triage-label-l2").querySelector(".lucide-minus")).not.toBeNull()
    expect(screen.getByTestId("triage-label-l1").querySelector(".lucide-minus")).toBeNull()
    fireEvent.click(screen.getByTestId("triage-label-l2"))
    expect(onToggle).toHaveBeenCalledWith("l2", "mixed")
    fireEvent.click(screen.getByTestId("triage-label-manage"))
    expect(onManage).toHaveBeenCalled()
  })

  it("falls back to plain items with a spoken state on a kit without checkboxes", () => {
    mockLabels.mockReturnValue(labels)
    const onToggle = jest.fn()
    render(
      <LabelMenuItems
        kit={PLAIN_KIT}
        stateOf={(id) => (id === "l3" ? "checked" : "unchecked")}
        onToggle={onToggle}
      />
    )
    const lead = screen.getByTestId("triage-label-l3")
    expect(within(lead).getByText("On")).toHaveAttribute("data-label-state", "checked")
    fireEvent.click(lead)
    expect(onToggle).toHaveBeenCalledWith("l3", "checked")
    expect(screen.queryByTestId("triage-label-manage")).not.toBeInTheDocument()
  })

  it("explains an empty catalog", () => {
    render(<LabelMenuItems kit={PLAIN_KIT} stateOf={() => "unchecked"} onToggle={jest.fn()} />)
    expect(screen.getByText(/No labels yet/)).toBeInTheDocument()
  })

  it("uses the kit's Label when it has no Heading", () => {
    const { Heading: _heading, ...withoutHeading } = PLAIN_KIT
    void _heading
    render(
      <LabelMenuItems
        kit={withoutHeading as MenuKit}
        stateOf={() => "unchecked"}
        onToggle={jest.fn()}
      />
    )
    expect(screen.getAllByTestId("plain-label")[0]).toHaveTextContent("Labels")
  })
})

describe("useAssigneeLabel", () => {
  it("words an assignee the way the chip does", () => {
    const { result } = renderHook(() => useAssigneeLabel())
    expect(result.current(undefined)).toBe("Unassigned")
    expect(result.current({ kind: "human" })).toBe("Me")
    expect(result.current({ kind: "team", id: "t" })).toBe("Team")
    expect(result.current({ kind: "team", id: "t", label: "Ops" })).toBe("Ops")
    expect(result.current({ kind: "character", id: "c" })).toBe("Character")
  })
})
