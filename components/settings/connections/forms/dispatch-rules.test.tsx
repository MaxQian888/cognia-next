/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { AdapterInstanceRow, DispatchRule } from "@/lib/db/connector-types"
import type { Character } from "@/lib/claude/types"

const mockUpdate = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    adapterInstances: { get: jest.fn() },
    characters: { toArray: jest.fn() },
  })),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  __esModule: true,
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))

// The component issues TWO useLiveQuery reads (adapter row, characters).
// Dispatch on the querier's source so each returns its fixture.
let fixtureRow: AdapterInstanceRow | undefined
let fixtureCharacters: Character[]
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    const src = String(fn)
    if (src.includes("adapterInstances")) return fixtureRow
    return fixtureCharacters
  },
}))

// Native-select stub (jsdom can't drive Radix portals) — same pattern as
// ai-binding-defaults.test.tsx; the trigger's data-testid rides through so
// selects can be told apart per rule/field.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
    ...rest
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children?: React.ReactNode
  }) => (
    <select value={value ?? ""} onChange={(e) => onValueChange?.(e.target.value)} {...rest}>
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

// Native-checkbox stub for the Radix Switch so fireEvent.click flips it
// deterministically in jsdom.
jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...rest
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked ?? false}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      {...rest}
    />
  ),
}))

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (
    selector: (s: { teams: Record<string, { id: string; name: string }> }) => unknown
  ) => selector({ teams: { team_a: { id: "team_a", name: "Team A" } } }),
}))

import { DispatchRules } from "./dispatch-rules"

// The component puts select testids on SelectTrigger, which the stub renders
// as null — so rule selects are queried by DOM order within their row
// instead: channel kind, action type, then the target picker (when the
// action type renders one).

function makeRow(rules: DispatchRule[] | undefined): AdapterInstanceRow {
  return {
    id: "a1",
    type: "telegram",
    displayName: "Bot A",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    dispatchRules: rules,
    createdAt: 0,
    updatedAt: 0,
  } as AdapterInstanceRow
}

const TEAM_RULE: DispatchRule = {
  id: "r1",
  enabled: true,
  name: "Bug triage",
  match: { keywords: ["bug", "crash"], channelKinds: ["group"] },
  action: { teamId: "team_a" },
}

const CHAR_RULE: DispatchRule = {
  id: "r2",
  match: {},
  action: { characterId: "c1" },
}

function setup(rules?: DispatchRule[]): void {
  fixtureRow = makeRow(rules)
  fixtureCharacters = [
    { id: "c1", name: "Researcher" } as Character,
    { id: "c2", name: "Writer" } as Character,
  ]
  mockUpdate.mockClear()
  render(<DispatchRules adapterId="a1" />)
}

/** The most recent persisted rules array. */
function lastPersisted(): DispatchRule[] {
  const call = mockUpdate.mock.calls.at(-1)
  expect(call?.[0]).toBe("a1")
  return (call?.[1] as { dispatchRules: DispatchRule[] }).dispatchRules
}

/** Selects inside one rule row, in DOM order: channel, action-type, [character target]. */
function rowSelects(ruleId: string): HTMLSelectElement[] {
  const row = screen.getByTestId(`dispatch-rule-row-${ruleId}`)
  return Array.from(row.querySelectorAll("select"))
}

describe("DispatchRules — rendering", () => {
  it("renders the card with an empty state and Add button when no rules exist", () => {
    setup(undefined)
    expect(screen.getByTestId("dispatch-rules")).toBeInTheDocument()
    expect(screen.getByTestId("dispatch-rule-add")).toBeInTheDocument()
    expect(screen.queryAllByTestId(/dispatch-rule-row-/)).toHaveLength(0)
  })

  it("renders one row per rule with its persisted values", () => {
    setup([TEAM_RULE, CHAR_RULE])
    expect(screen.getByTestId("dispatch-rule-row-r1")).toBeInTheDocument()
    expect(screen.getByTestId("dispatch-rule-row-r2")).toBeInTheDocument()
    expect(screen.getByTestId("dispatch-rule-name-r1")).toHaveValue("Bug triage")
    expect(screen.getByTestId("dispatch-rule-keywords-r1")).toHaveValue("bug, crash")
    const [channel, actionType] = rowSelects("r1")
    expect(channel.value).toBe("group")
    expect(actionType.value).toBe("team")
  })

  it("flags an invalid regex pattern inline", () => {
    setup([{ ...TEAM_RULE, match: { pattern: "([unclosed" } }])
    expect(screen.getByTestId("dispatch-rule-pattern-invalid-r1")).toBeInTheDocument()
  })
})

describe("DispatchRules — add / edit / delete / reorder persistence", () => {
  it("Add rule appends an enabled catch-all rule with a fresh id", () => {
    setup([TEAM_RULE])
    fireEvent.click(screen.getByTestId("dispatch-rule-add"))
    const rules = lastPersisted()
    expect(rules).toHaveLength(2)
    expect(rules[0]).toEqual(TEAM_RULE)
    expect(rules[1]).toMatchObject({ enabled: true, match: {}, action: {} })
    expect(typeof rules[1].id).toBe("string")
    expect(rules[1].id).not.toBe("r1")
  })

  it("toggling the enabled switch persists enabled: false", () => {
    setup([TEAM_RULE])
    fireEvent.click(screen.getByTestId("dispatch-rule-enabled-r1"))
    expect(lastPersisted()[0].enabled).toBe(false)
  })

  it("editing the name persists it (blank clears to undefined)", () => {
    setup([TEAM_RULE])
    fireEvent.change(screen.getByTestId("dispatch-rule-name-r1"), {
      target: { value: "Escalations" },
    })
    expect(lastPersisted()[0].name).toBe("Escalations")
    fireEvent.change(screen.getByTestId("dispatch-rule-name-r1"), { target: { value: "  " } })
    expect(lastPersisted()[0].name).toBeUndefined()
  })

  it("editing keywords persists a trimmed list and clears on empty", () => {
    setup([TEAM_RULE])
    fireEvent.change(screen.getByTestId("dispatch-rule-keywords-r1"), {
      target: { value: " deploy ,  release ,, " },
    })
    expect(lastPersisted()[0].match.keywords).toEqual(["deploy", "release"])
    fireEvent.change(screen.getByTestId("dispatch-rule-keywords-r1"), { target: { value: "" } })
    expect(lastPersisted()[0].match.keywords).toBeUndefined()
  })

  it("editing pattern and senderIds persists them", () => {
    setup([TEAM_RULE])
    fireEvent.change(screen.getByTestId("dispatch-rule-pattern-r1"), {
      target: { value: "^urgent:" },
    })
    expect(lastPersisted()[0].match.pattern).toBe("^urgent:")
    fireEvent.change(screen.getByTestId("dispatch-rule-senders-r1"), {
      target: { value: "u_1, ou_2" },
    })
    expect(lastPersisted()[0].match.senderIds).toEqual(["u_1", "ou_2"])
  })

  it("changing channel kind persists a one-element array; Any clears it", () => {
    setup([TEAM_RULE])
    const [channel] = rowSelects("r1")
    fireEvent.change(channel, { target: { value: "private" } })
    expect(lastPersisted()[0].match.channelKinds).toEqual(["private"])
    fireEvent.change(channel, { target: { value: "__any__" } })
    expect(lastPersisted()[0].match.channelKinds).toBeUndefined()
  })

  it("switching the action type clears the previous target", () => {
    setup([TEAM_RULE])
    const [, actionType] = rowSelects("r1")
    fireEvent.change(actionType, { target: { value: "workflow" } })
    expect(lastPersisted()[0].action).toEqual({})
  })

  it("picking a character persists action.characterId", () => {
    setup([CHAR_RULE])
    const selects = rowSelects("r2")
    // channel, action-type, character target.
    fireEvent.change(selects[2], { target: { value: "c2" } })
    expect(lastPersisted()[0].action).toEqual({ characterId: "c2" })
  })

  it("editing the workflow id persists action.workflowId", () => {
    setup([{ id: "r3", match: {}, action: { workflowId: "wf_1" } }])
    fireEvent.change(screen.getByTestId("dispatch-rule-workflow-r3"), {
      target: { value: "wf_2" },
    })
    expect(lastPersisted()[0].action).toEqual({ workflowId: "wf_2" })
  })

  it("picking a team through the TeamPicker persists action.teamId", () => {
    setup([{ id: "r4", match: {}, action: { teamId: undefined } }])
    // Row r4 derives action type "character" (no teamId set) — flip to team.
    const [, actionType] = rowSelects("r4")
    fireEvent.change(actionType, { target: { value: "team" } })
    // After the type flip the target select is the TeamPicker.
    const selects = rowSelects("r4")
    fireEvent.change(selects[2], { target: { value: "team_a" } })
    expect(lastPersisted()[0].action).toEqual({ teamId: "team_a" })
  })

  it("delete removes exactly that rule", () => {
    setup([TEAM_RULE, CHAR_RULE])
    fireEvent.click(screen.getByTestId("dispatch-rule-delete-r1"))
    const rules = lastPersisted()
    expect(rules).toHaveLength(1)
    expect(rules[0].id).toBe("r2")
  })

  it("move down / move up swap adjacent rules (array order = priority)", () => {
    setup([TEAM_RULE, CHAR_RULE])
    fireEvent.click(screen.getByTestId("dispatch-rule-down-r1"))
    expect(lastPersisted().map((r) => r.id)).toEqual(["r2", "r1"])
    fireEvent.click(screen.getByTestId("dispatch-rule-up-r2"))
    expect(lastPersisted().map((r) => r.id)).toEqual(["r2", "r1"])
  })

  it("disables move-up on the first row and move-down on the last row", () => {
    setup([TEAM_RULE, CHAR_RULE])
    expect(screen.getByTestId("dispatch-rule-up-r1")).toBeDisabled()
    expect(screen.getByTestId("dispatch-rule-down-r2")).toBeDisabled()
  })
})
