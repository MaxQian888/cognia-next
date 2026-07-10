/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { AppSettings, Character } from "@/lib/claude/types"

const mockUpdate = jest.fn().mockResolvedValue(undefined)

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(() => ({
    adapterInstances: { get: jest.fn() },
    settings: { get: jest.fn() },
    characters: { toArray: jest.fn() },
  })),
}))

jest.mock("@/lib/db/adapter-instances", () => ({
  __esModule: true,
  updateAdapterInstance: (...a: unknown[]) => mockUpdate(...a),
}))

// The component issues THREE useLiveQuery reads (adapter row, app settings,
// characters). Dispatch on the querier's source so each returns its fixture.
let fixtureRow: AdapterInstanceRow | undefined
let fixtureSettings: AppSettings | undefined
let fixtureCharacters: Character[]
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    const src = String(fn)
    if (src.includes("adapterInstances")) return fixtureRow
    if (src.includes("settings")) return fixtureSettings
    return fixtureCharacters
  },
}))

// Native-select stub (jsdom can't drive Radix portals). Multiple selects per
// render are told apart by DOM order: character, team, model, reasoning.
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
    <select value={value ?? ""} onChange={(e) => onValueChange?.(e.target.value)}>
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

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: { teams: Record<string, never> }) => unknown) =>
    selector({ teams: {} }),
}))

import { AiBindingDefaults } from "./ai-binding-defaults"

function makeRow(over: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "a1",
    type: "lark",
    displayName: "Bot A",
    enabled: true,
    transportMode: "long-connection",
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as AdapterInstanceRow
}

function setup(over: Partial<AdapterInstanceRow> = {}): void {
  fixtureRow = makeRow(over)
  fixtureSettings = {
    providerSettings: {
      anthropic: { enabled: true, models: ["claude-fable-5", "claude-opus-4-8"] },
    },
  } as unknown as AppSettings
  fixtureCharacters = [
    { id: "c1", name: "Researcher" } as Character,
    { id: "c2", name: "Writer" } as Character,
  ]
  mockUpdate.mockClear()
  render(<AiBindingDefaults adapterId="a1" />)
}

/** DOM order of the four selects: character, team, model, reasoning. */
function selects(): HTMLSelectElement[] {
  return screen.getAllByRole("combobox") as HTMLSelectElement[]
}

describe("AiBindingDefaults", () => {
  it("renders the section with all four fields defaulted", () => {
    setup()
    expect(screen.getByTestId("ai-binding-defaults")).toBeInTheDocument()
    const [character, team, model, reasoning] = selects()
    expect(character.value).toBe("__default__")
    expect(team.value).toBe("__none__")
    expect(model.value).toBe("__default__")
    expect(reasoning.value).toBe("__default__")
  })

  it("persists a picked character and clears it via the Default entry", () => {
    setup()
    const [character] = selects()
    fireEvent.change(character, { target: { value: "c2" } })
    expect(mockUpdate).toHaveBeenLastCalledWith("a1", { defaultCharacterId: "c2" })
    setup({ defaultCharacterId: "c2" })
    fireEvent.change(selects()[0], { target: { value: "__default__" } })
    expect(mockUpdate).toHaveBeenLastCalledWith("a1", { defaultCharacterId: undefined })
  })

  it("persists defaultTeamId through the TeamPicker", () => {
    setup()
    const [, team] = selects()
    fireEvent.change(team, { target: { value: "__none__" } })
    // No-op change still routes through onChange → persist(undefined).
    expect(mockUpdate).toHaveBeenLastCalledWith("a1", { defaultTeamId: undefined })
  })

  it("persists provider+model together and clears both via Default", () => {
    setup()
    const [, , model] = selects()
    fireEvent.change(model, { target: { value: "anthropic:claude-fable-5" } })
    expect(mockUpdate).toHaveBeenLastCalledWith("a1", {
      defaultProvider: "anthropic",
      defaultModel: "claude-fable-5",
    })
    setup({ defaultProvider: "anthropic", defaultModel: "claude-fable-5" })
    fireEvent.change(selects()[2], { target: { value: "__default__" } })
    expect(mockUpdate).toHaveBeenLastCalledWith("a1", {
      defaultProvider: undefined,
      defaultModel: undefined,
    })
  })

  it("keeps a stale saved model visible as a clearable (not configured) entry", () => {
    setup({ defaultProvider: "ghost", defaultModel: "gone-model" })
    const [, , model] = selects()
    expect(model.value).toBe("ghost:gone-model")
    expect(screen.getByTestId("ai-binding-model-missing")).toBeInTheDocument()
  })

  it("keeps a stale character id visible as a missing entry", () => {
    setup({ defaultCharacterId: "deleted-char" })
    expect(screen.getByTestId("ai-binding-character-missing")).toBeInTheDocument()
  })

  it("persists defaultReasoning and clears via Default", () => {
    setup()
    const [, , , reasoning] = selects()
    fireEvent.change(reasoning, { target: { value: "high" } })
    expect(mockUpdate).toHaveBeenLastCalledWith("a1", { defaultReasoning: "high" })
    setup({ defaultReasoning: "high" })
    fireEvent.change(selects()[3], { target: { value: "__default__" } })
    expect(mockUpdate).toHaveBeenLastCalledWith("a1", { defaultReasoning: undefined })
  })
})
