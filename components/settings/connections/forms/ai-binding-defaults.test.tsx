import { fireEvent, render, screen } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const updateSection = jest.fn().mockResolvedValue(undefined)
let row: AdapterInstanceRow | undefined
const workflows = [{ id: "wf_active", name: "Active Workflow" }]

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/db/adapter-instances", () => ({
  updateAdapterConfigSection: (...args: unknown[]) => updateSection(...args),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    const source = String(fn)
    if (source.includes("adapterInstances")) return row
    if (source.includes("settings")) return undefined
    if (source.includes("characters")) return [{ id: "char_1", name: "Sage" }]
    return workflows
  },
}))
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (state: unknown) => unknown) =>
    selector({ teams: { team_1: { id: "team_1", name: "Agent Team One" } } }),
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value ?? ""} onChange={(event) => onValueChange?.(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children, ...props }: React.ComponentProps<"option">) => (
    <option value={value} {...props}>
      {children}
    </option>
  ),
}))

import { AiBindingDefaults } from "./ai-binding-defaults"

function makeRow(patch: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "a1",
    type: "telegram",
    displayName: "Bot",
    enabled: true,
    transportMode: "longpoll",
    settings: {},
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

beforeEach(() => {
  row = makeRow()
  updateSection.mockClear()
})

it("atomically saves mutually exclusive Agent Team targeting", () => {
  render(<AiBindingDefaults adapterId="a1" />)
  fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "team" } })
  const team = screen.getAllByRole("combobox")[1]
  fireEvent.change(team, { target: { value: "team_1" } })
  fireEvent.click(screen.getByText("save"))
  expect(updateSection).toHaveBeenCalledWith(
    "a1",
    "responder",
    expect.objectContaining({ defaultTeamId: "team_1", defaultWorkflowId: undefined }),
    "settings.adapter.responder"
  )
})

it("lists only executable production workflows and marks model as target-managed", () => {
  row = makeRow({ defaultWorkflowId: "wf_active" })
  render(<AiBindingDefaults adapterId="a1" />)
  expect(screen.getByText(/Active Workflow/)).toBeInTheDocument()
  expect(screen.getByTestId("ai-binding-target-managed")).toHaveTextContent("modelManagedByTarget")
})

it("keeps stale Character and Workflow references visible", () => {
  row = makeRow({ defaultWorkflowId: "wf_missing", defaultCharacterId: "char_missing" })
  render(<AiBindingDefaults adapterId="a1" />)
  expect(screen.getByTestId("ai-binding-workflow-missing")).toBeInTheDocument()
  expect(screen.getByTestId("ai-binding-character-missing")).toBeInTheDocument()
})
