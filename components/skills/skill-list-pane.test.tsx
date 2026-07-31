/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const storeState = {
  filters: {
    query: "",
    category: "all" as const,
    source: "all" as const,
    status: "all" as const,
    tag: null,
    sort: "name" as const,
  },
  selection: new Set<string>(),
  detailSkillId: null as string | null,
  setQuery: jest.fn(),
  setFilters: jest.fn(),
  toggleSelection: jest.fn(),
  openDetail: jest.fn(),
}

jest.mock("@/stores/skills", () => ({
  useSkillsStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}))

const mockUsePrefs = jest.fn()
jest.mock("@/hooks/skills", () => ({
  useSkillPanelPrefs: () => mockUsePrefs(),
}))

const mockSetSkillPanelPrefs = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { setSkillPanelPrefs: jest.Mock }) => unknown) =>
    selector({ setSkillPanelPrefs: mockSetSkillPanelPrefs }),
}))

jest.mock("./skill-list-item", () => ({
  SkillListItem: ({
    skill,
    active,
    onOpen,
  }: {
    skill: { id: string; name: string }
    active: boolean
    onOpen: (id: string) => void
  }) => (
    <div data-testid="skill-list-item" data-active={active} onClick={() => onOpen(skill.id)}>
      {skill.name}
    </div>
  ),
}))

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SkillListPane } from "./skill-list-pane"
import { DEFAULT_SKILL_PANEL_PREFS } from "@/lib/skills/preferences"
import type { Skill } from "@cognia/agent-config-types"

const skills = [
  { id: "s1", name: "Alpha", content: "", source: "custom", createdAt: 0, updatedAt: 0 },
  { id: "s2", name: "Beta", content: "", source: "custom", createdAt: 0, updatedAt: 0 },
] as Skill[]

const baseProps = {
  skills,
  total: 2,
  enabledCount: 1,
  countsBySource: { custom: 2 },
  countsByCategory: { development: 1 },
  onCreate: jest.fn(),
}

beforeEach(() => {
  jest.clearAllMocks()
  storeState.detailSkillId = null
  storeState.filters = { ...storeState.filters, query: "", category: "all", source: "all" }
  mockUsePrefs.mockReturnValue({ ...DEFAULT_SKILL_PANEL_PREFS })
})

describe("SkillListPane", () => {
  it("renders a search input carrying data-skill-search and writes setQuery", () => {
    render(<SkillListPane {...baseProps} />)
    const input = document.querySelector("[data-skill-search]") as HTMLInputElement
    expect(input).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "alp" } })
    expect(storeState.setQuery).toHaveBeenCalledWith("alp")
  })

  it("renders one list item per skill and marks the detail row active", () => {
    storeState.detailSkillId = "s2"
    render(<SkillListPane {...baseProps} />)
    const items = screen.getAllByTestId("skill-list-item")
    expect(items).toHaveLength(2)
    expect(items[1]).toHaveAttribute("data-active", "true")
  })

  it("selecting a source resets category to all", async () => {
    const user = userEvent.setup()
    render(<SkillListPane {...baseProps} />)
    await user.click(screen.getByLabelText("panel.selectSourceAria"))
    await user.click(await screen.findByText(/source\.custom/))
    expect(storeState.setFilters).toHaveBeenCalledWith({ source: "custom", category: "all" })
  })

  it("selecting a category resets source to all", async () => {
    const user = userEvent.setup()
    render(<SkillListPane {...baseProps} />)
    await user.click(screen.getByLabelText("panel.selectCategoryAria"))
    await user.click(await screen.findByText(/category\.development/))
    expect(storeState.setFilters).toHaveBeenCalledWith({
      category: "development",
      source: "all",
    })
  })

  it("renders the empty state with create action when there are no skills", () => {
    render(<SkillListPane {...baseProps} skills={[]} />)
    expect(screen.getByText("panel.emptyTitle")).toBeInTheDocument()
    fireEvent.click(screen.getByText("panel.emptyAction"))
    expect(baseProps.onCreate).toHaveBeenCalled()
  })

  it("renders the stats bar with enabled and total counts", () => {
    render(<SkillListPane {...baseProps} />)
    expect(screen.getByText('panel.statsBar:{"enabled":1,"total":2}')).toBeInTheDocument()
  })

  it("changes the current sort via the visible sort control", async () => {
    const user = userEvent.setup()
    render(<SkillListPane {...baseProps} />)
    await user.click(screen.getByLabelText("filter.sortBy"))
    await user.click(await screen.findByText("filter.sortUpdated"))
    expect(storeState.setFilters).toHaveBeenCalledWith({ sort: "updated" })
  })

  it("persists the view mode when the grid toggle is clicked", () => {
    render(<SkillListPane {...baseProps} />)
    fireEvent.click(screen.getByTestId("skill-view-grid"))
    expect(mockSetSkillPanelPrefs).toHaveBeenCalledWith({ viewMode: "grid" })
  })

  it("marks the active view-mode button as pressed", () => {
    mockUsePrefs.mockReturnValue({ ...DEFAULT_SKILL_PANEL_PREFS, viewMode: "grid" })
    render(<SkillListPane {...baseProps} />)
    expect(screen.getByTestId("skill-view-grid")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("skill-view-list")).toHaveAttribute("aria-pressed", "false")
  })

  it("persists the view mode when the list toggle is clicked", () => {
    mockUsePrefs.mockReturnValue({ ...DEFAULT_SKILL_PANEL_PREFS, viewMode: "grid" })
    render(<SkillListPane {...baseProps} />)
    fireEvent.click(screen.getByTestId("skill-view-list"))
    expect(mockSetSkillPanelPrefs).toHaveBeenCalledWith({ viewMode: "list" })
  })

  it("uses a grid container in grid mode and keeps the empty state visible", () => {
    mockUsePrefs.mockReturnValue({ ...DEFAULT_SKILL_PANEL_PREFS, viewMode: "grid" })
    const { rerender } = render(<SkillListPane {...baseProps} />)
    expect(screen.getByTestId("skill-list").className).toMatch(/grid/)
    rerender(<SkillListPane {...baseProps} skills={[]} />)
    expect(screen.getByText("panel.emptyTitle")).toBeInTheDocument()
  })

  it("shows the enabled-budget warning when the threshold is exceeded", () => {
    mockUsePrefs.mockReturnValue({ ...DEFAULT_SKILL_PANEL_PREFS, enabledWarnThreshold: 1 })
    render(<SkillListPane {...baseProps} enabledCount={3} />)
    expect(screen.getByTestId("skill-budget-warning")).toBeInTheDocument()
    expect(screen.getByText('prefs.budgetWarning:{"count":3,"threshold":1}')).toBeInTheDocument()
  })

  it("hides the budget warning when disabled (threshold 0) or under budget", () => {
    render(<SkillListPane {...baseProps} enabledCount={99} />)
    expect(screen.queryByTestId("skill-budget-warning")).not.toBeInTheDocument()
    mockUsePrefs.mockReturnValue({ ...DEFAULT_SKILL_PANEL_PREFS, enabledWarnThreshold: 10 })
    render(<SkillListPane {...baseProps} enabledCount={5} />)
    expect(screen.queryByTestId("skill-budget-warning")).not.toBeInTheDocument()
  })
})
