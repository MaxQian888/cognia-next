/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const mobileRef = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileRef.current,
}))

import {
  ConversationFilterChips,
  ConversationFilterMenu,
  type ConversationFilterViewModel,
} from "./conversation-filter-controls"
import { EMPTY_CONVERSATION_FILTER_OPTIONS } from "@/lib/chat/conversation-filter-options"
import {
  CONVERSATION_FILTER_UNASSIGNED,
  EMPTY_CONVERSATION_FILTERS,
} from "@/lib/chat/conversation-filters"

function makeModel(overrides: Partial<ConversationFilterViewModel> = {}) {
  const actions = {
    toggle: jest.fn(),
    setKind: jest.fn(),
    setList: jest.fn(),
    toggleValue: jest.fn(),
    setActivity: jest.fn(),
    reset: jest.fn(),
    setSortBy: jest.fn(),
    applyPreset: jest.fn(),
    savePreset: jest.fn(() => "new-id"),
    renamePreset: jest.fn(),
    deletePreset: jest.fn(),
  }
  const model: ConversationFilterViewModel = {
    filters: EMPTY_CONVERSATION_FILTERS,
    activeFilters: 0,
    sortBy: "recent",
    options: EMPTY_CONVERSATION_FILTER_OPTIONS,
    presets: [],
    activePreset: undefined,
    actions,
    ...overrides,
  }
  return { model, actions }
}

const richOptions = {
  ...EMPTY_CONVERSATION_FILTER_OPTIONS,
  workspaceIds: [
    { value: "w1", label: "Alpha", count: 3 },
    { value: CONVERSATION_FILTER_UNASSIGNED, label: null, count: 1 },
  ],
  agentIds: [{ value: "c1", label: "Alice", count: 2 }],
  models: [{ value: "claude", label: "Claude", count: 4 }],
}

function menu(overrides: Partial<ConversationFilterViewModel> = {}) {
  const { model, actions } = makeModel(overrides)
  const utils = render(<ConversationFilterMenu model={model} />)
  return { ...utils, actions, model }
}

function chips(
  overrides: Partial<ConversationFilterViewModel> = {},
  counts: { shown?: number; total?: number } = {}
) {
  const { model, actions } = makeModel(overrides)
  const utils = render(
    <ConversationFilterChips model={model} shown={counts.shown ?? 0} total={counts.total ?? 0} />
  )
  return { ...utils, actions }
}

beforeEach(() => {
  mobileRef.current = false
})

/**
 * Menu items are activated with `fireEvent.click` (Radix wires select onto
 * `onClick`): `user.click` moves the pointer off the hover-opened sub trigger
 * first, and jsdom's zero-size rects make Radix read that as "left the
 * submenu", closing it before the click lands. Hover itself — the real open
 * gesture — is still driven through `user.hover`.
 */
const pick = (element: HTMLElement) => fireEvent.click(element)

/** vaul's drawer captures the pointer on press, which jsdom cannot do — click without a pointer sequence. */
const tap = (element: HTMLElement) => fireEvent.click(element)

describe("ConversationFilterMenu (desktop)", () => {
  it("labels the trigger plainly when nothing is filtered", () => {
    menu()
    const trigger = screen.getByTestId("conversation-filter-trigger")
    expect(trigger).toHaveAccessibleName("label")
    expect(trigger).not.toHaveAttribute("data-active-filters")
    expect(screen.queryByTestId("conversation-filter-trigger-dot")).toBeNull()
  })

  it("badges the trigger with the active count once filtered", () => {
    menu({ activeFilters: 2 })
    const trigger = screen.getByTestId("conversation-filter-trigger")
    expect(trigger).toHaveAccessibleName('labelActive:{"count":2}')
    expect(trigger).toHaveAttribute("data-active-filters", "2")
    expect(screen.getByTestId("conversation-filter-trigger-dot")).toHaveTextContent("2")
  })

  it("opens beside the trigger with one submenu per facet, hiding facets with nothing to offer", async () => {
    const user = userEvent.setup()
    menu()
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const content = await screen.findByTestId("conversation-filter-trigger-menu")
    expect(content).toHaveAttribute("data-side", "right")
    const rows = within(content).getAllByRole("menuitem")
    expect(rows.map((r) => r.textContent)).toEqual([
      "presets.label",
      "sort.labelsort.options.recent",
      "filters.label",
      "activity.label",
    ])
    expect(screen.queryByTestId("conversation-filter-trigger-section-location")).toBeNull()
  })

  it("lists the location / agent / model sections once options exist, with per-section counts", async () => {
    const user = userEvent.setup()
    menu({
      options: richOptions,
      filters: { ...EMPTY_CONVERSATION_FILTERS, workspaceIds: ["w1"], models: ["claude"] },
      activeFilters: 2,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const location = await screen.findByTestId("conversation-filter-trigger-section-location")
    expect(location).toHaveTextContent("sections.location")
    expect(location).toHaveTextContent('selectedSummary:{"count":1}')
    expect(within(location).getByTestId("conversation-filter-section-count")).toHaveTextContent("1")
    expect(screen.getByTestId("conversation-filter-trigger-section-agent")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-filter-trigger-section-model")).toBeInTheDocument()
  })

  it("expands the sort submenu on hover and reports the choice", async () => {
    const user = userEvent.setup()
    const { actions } = menu()
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByTestId("conversation-filter-trigger-section-sort"))
    const options = await screen.findAllByRole("menuitemradio")
    expect(options.map((o) => o.textContent)).toEqual([
      "sort.options.recent",
      "sort.options.oldest",
      "sort.options.created",
      "sort.options.title",
      "sort.options.unread",
    ])
    expect(screen.getByRole("menuitemradio", { name: "sort.options.recent" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    pick(screen.getByRole("menuitemradio", { name: "sort.options.unread" }))
    expect(actions.setSortBy).toHaveBeenCalledWith("unread")
    // The menu stays open — it is a filter builder, not a command list.
    expect(screen.getByTestId("conversation-filter-trigger-menu")).toBeInTheDocument()
  })

  it("toggles boolean facets and the kind radio inside the status submenu", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      filters: { ...EMPTY_CONVERSATION_FILTERS, pinned: true },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByTestId("conversation-filter-trigger-section-status"))
    expect(
      await screen.findByRole("menuitemcheckbox", { name: "filters.options.pinned" })
    ).toHaveAttribute("aria-checked", "true")
    pick(screen.getByRole("menuitemcheckbox", { name: "filters.options.unread" }))
    expect(actions.toggle).toHaveBeenCalledWith("unread", true)
    pick(screen.getByRole("menuitemcheckbox", { name: "filters.options.pinned" }))
    expect(actions.toggle).toHaveBeenCalledWith("pinned", false)
    pick(screen.getByRole("menuitemradio", { name: "kind.options.team" }))
    expect(actions.setKind).toHaveBeenCalledWith("team")
  })

  it("offers an 'any' row plus counted values for each list facet, using the unassigned label", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      options: richOptions,
      filters: { ...EMPTY_CONVERSATION_FILTERS, workspaceIds: ["w1"] },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByTestId("conversation-filter-trigger-section-location"))
    const any = await screen.findByRole("menuitemcheckbox", { name: /workspace\.any/ })
    expect(any).toHaveAttribute("aria-checked", "false")
    const alpha = screen.getByRole("menuitemcheckbox", { name: /Alpha/ })
    expect(alpha).toHaveAttribute("aria-checked", "true")
    expect(alpha).toHaveTextContent("3")
    expect(
      screen.getByRole("menuitemcheckbox", { name: /workspace\.unassigned/ })
    ).toBeInTheDocument()
    pick(screen.getByRole("menuitemcheckbox", { name: /workspace\.unassigned/ }))
    expect(actions.toggleValue).toHaveBeenCalledWith(
      "workspaceIds",
      CONVERSATION_FILTER_UNASSIGNED,
      true
    )
    pick(alpha)
    expect(actions.toggleValue).toHaveBeenCalledWith("workspaceIds", "w1", false)
    pick(any)
    expect(actions.setList).toHaveBeenCalledWith("workspaceIds", [])
  })

  it("changes the activity window", async () => {
    const user = userEvent.setup()
    const { actions } = menu()
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByTestId("conversation-filter-trigger-section-activity"))
    pick(await screen.findByRole("menuitemradio", { name: "activity.options.week" }))
    expect(actions.setActivity).toHaveBeenCalledWith("week")
  })

  it("hides the reset entry until there is something to reset, then resets", async () => {
    const user = userEvent.setup()
    const { actions, unmount } = menu()
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await screen.findByTestId("conversation-filter-trigger-menu")
    expect(screen.queryByRole("menuitem", { name: "clearAll" })).toBeNull()
    await user.keyboard("{Escape}")
    unmount()

    const second = menu({
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.click(await screen.findByRole("menuitem", { name: "clearAll" }))
    expect(second.actions.reset).toHaveBeenCalled()
    expect(actions.reset).not.toHaveBeenCalled()
  })

  it("lists presets, marks the active one, applies on click and gates 'save' on unsaved active filters", async () => {
    const user = userEvent.setup()
    const presets = [
      { id: "p1", name: "Unread", filters: { unread: true }, createdAt: 1 },
      { id: "p2", name: "Teams", filters: { kind: "team" as const }, createdAt: 2 },
    ]
    const { actions } = menu({
      presets,
      activePreset: presets[1],
      filters: { ...EMPTY_CONVERSATION_FILTERS, kind: "team" },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const row = await screen.findByRole("menuitem", { name: /presets\.label/ })
    expect(row).toHaveTextContent("Teams")
    await user.hover(row)
    const teams = await screen.findByRole("menuitemcheckbox", { name: "Teams" })
    expect(teams).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("menuitemcheckbox", { name: "Unread" })).toHaveAttribute(
      "aria-checked",
      "false"
    )
    // Already saved → nothing new to save.
    expect(screen.getByRole("menuitem", { name: "presets.save" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(screen.getByRole("menuitem", { name: "presets.manage" })).toBeInTheDocument()
    pick(screen.getByRole("menuitemcheckbox", { name: "Unread" }))
    expect(actions.applyPreset).toHaveBeenCalledWith("p1")
  })

  it("saves the active filters as a named preset through the dialog", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /presets\.label/ }))
    expect(await screen.findByText("presets.empty")).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "presets.manage" })).toBeNull()
    pick(screen.getByRole("menuitem", { name: "presets.save" }))
    const dialog = await screen.findByTestId("conversation-filter-save-dialog")
    expect(within(dialog).getByRole("button", { name: "presets.saveAction" })).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox"), "Mine")
    await user.click(within(dialog).getByRole("button", { name: "presets.saveAction" }))
    expect(actions.savePreset).toHaveBeenCalledWith("Mine")
    expect(screen.queryByTestId("conversation-filter-save-dialog")).toBeNull()
  })

  it("keeps the save dialog open with an error when the controller refuses the preset", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true },
      activeFilters: 1,
    })
    actions.savePreset.mockReturnValue(null)
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /presets\.label/ }))
    pick(await screen.findByRole("menuitem", { name: "presets.save" }))
    const dialog = await screen.findByTestId("conversation-filter-save-dialog")
    await user.type(within(dialog).getByRole("textbox"), "x")
    await user.keyboard("{Enter}")
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("presets.saveRejected")
    expect(screen.getByTestId("conversation-filter-save-dialog")).toBeInTheDocument()
  })

  it("renames and deletes presets from the manage dialog, closing when the last one goes", async () => {
    const user = userEvent.setup()
    const presets = [
      { id: "p1", name: "Unread", filters: { unread: true }, createdAt: 1 },
      { id: "p2", name: "Teams", filters: { kind: "team" as const }, createdAt: 2 },
    ]
    const { actions, rerender, model } = menu({ presets })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /presets\.label/ }))
    pick(await screen.findByRole("menuitem", { name: "presets.manage" }))
    const dialog = await screen.findByTestId("conversation-filter-manage-dialog")
    const rename = within(dialog).getByRole("textbox", { name: 'presets.rename:{"name":"Unread"}' })
    await user.clear(rename)
    await user.type(rename, "Unread only{Enter}")
    expect(actions.renamePreset).toHaveBeenCalledWith("p1", "Unread only")

    await user.click(
      within(dialog).getByRole("button", { name: 'presets.delete:{"name":"Unread"}' })
    )
    expect(actions.deletePreset).toHaveBeenCalledWith("p1")
    expect(screen.getByTestId("conversation-filter-manage-dialog")).toBeInTheDocument()

    rerender(<ConversationFilterMenu model={{ ...model, presets: [presets[1]] }} />)
    await user.click(screen.getByRole("button", { name: 'presets.delete:{"name":"Teams"}' }))
    expect(actions.deletePreset).toHaveBeenCalledWith("p2")
    expect(screen.queryByTestId("conversation-filter-manage-dialog")).toBeNull()
  })

  it("takes a per-surface trigger id so two lists stay distinguishable", () => {
    const { model } = makeModel()
    render(<ConversationFilterMenu model={model} testId="mobile-channel-filter" />)
    expect(screen.getByTestId("mobile-channel-filter")).toBeInTheDocument()
  })
})

describe("ConversationFilterMenu (mobile drawer)", () => {
  beforeEach(() => {
    mobileRef.current = true
  })

  it("opens a bottom drawer with accordion sections and 44px rows instead of a dropdown", async () => {
    const user = userEvent.setup()
    const { actions } = menu({ options: richOptions })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const drawer = await screen.findByTestId("conversation-filter-trigger-drawer")
    expect(within(drawer).getByText("drawer.title")).toBeInTheDocument()
    expect(screen.queryByTestId("conversation-filter-trigger-menu")).toBeNull()
    // Sort + status start expanded; the rest folded.
    expect(within(drawer).getByTestId("conversation-filter-trigger-section-sort")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(
      within(drawer).getByTestId("conversation-filter-trigger-section-location")
    ).toHaveAttribute("aria-expanded", "false")
    tap(within(drawer).getByRole("radio", { name: "sort.options.title" }))
    expect(actions.setSortBy).toHaveBeenCalledWith("title")
    tap(within(drawer).getByRole("checkbox", { name: "filters.options.unread" }))
    expect(actions.toggle).toHaveBeenCalledWith("unread", true)

    tap(within(drawer).getByTestId("conversation-filter-trigger-section-location"))
    const alpha = await within(drawer).findByRole("checkbox", { name: /Alpha/ })
    expect(alpha.closest("label")).toHaveClass("min-h-11")
    tap(alpha)
    expect(actions.toggleValue).toHaveBeenCalledWith("workspaceIds", "w1", true)
  })

  it("shows presets as tappable chips and routes save / manage to the dialogs", async () => {
    const user = userEvent.setup()
    const presets = [{ id: "p1", name: "Unread", filters: { unread: true }, createdAt: 1 }]
    const { actions } = menu({
      presets,
      filters: { ...EMPTY_CONVERSATION_FILTERS, pinned: true },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const drawer = await screen.findByTestId("conversation-filter-trigger-drawer")
    tap(within(drawer).getByRole("button", { name: "Unread" }))
    expect(actions.applyPreset).toHaveBeenCalledWith("p1")
    tap(within(drawer).getByRole("button", { name: "presets.manage" }))
    expect(await screen.findByTestId("conversation-filter-manage-dialog")).toBeInTheDocument()
  })

  it("clears everything from the footer when filters are active", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const drawer = await screen.findByTestId("conversation-filter-trigger-drawer")
    tap(within(drawer).getByRole("button", { name: "clearAll" }))
    expect(actions.reset).toHaveBeenCalled()
  })
})

describe("ConversationFilterChips", () => {
  it("renders nothing in the default, unnarrowed state", () => {
    const { container } = chips()
    expect(container).toBeEmptyDOMElement()
  })

  it("surfaces a non-default sort even with no filters, without count or reset", () => {
    chips({ sortBy: "title" })
    expect(screen.getByTestId("conversation-filter-chips")).toHaveTextContent("sort.options.title")
    expect(screen.queryByTestId("conversation-filter-chips-count")).toBeNull()
    expect(screen.queryByRole("button", { name: "clearAll" })).toBeNull()
  })

  it("renders one removable chip per active boolean facet and the kind", async () => {
    const user = userEvent.setup()
    const { actions } = chips({
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, pinned: true, kind: "dm" },
      activeFilters: 3,
    })
    await user.click(
      screen.getByRole("button", { name: 'remove:{"name":"filters.options.pinned"}' })
    )
    expect(actions.toggle).toHaveBeenCalledWith("pinned", false)
    await user.click(screen.getByRole("button", { name: 'remove:{"name":"kind.options.dm"}' }))
    expect(actions.setKind).toHaveBeenCalledWith("all")
  })

  it("collapses list facets into one chip naming up to two values, and the activity window into another", async () => {
    const user = userEvent.setup()
    const { actions } = chips({
      options: {
        ...richOptions,
        workspaceIds: [
          { value: "w1", label: "Alpha", count: 1 },
          { value: "w2", label: "Beta", count: 1 },
          { value: "w3", label: "Gamma", count: 1 },
        ],
      },
      filters: {
        ...EMPTY_CONVERSATION_FILTERS,
        workspaceIds: ["w1", "w2", "w3", CONVERSATION_FILTER_UNASSIGNED],
        activity: "month",
      },
      activeFilters: 2,
    })
    const root = screen.getByTestId("conversation-filter-chips")
    expect(root).toHaveTextContent("workspace.label: Alpha, Beta +2")
    expect(root).toHaveTextContent("activity.options.month")
    await user.click(screen.getByRole("button", { name: 'remove:{"name":"workspace.label"}' }))
    expect(actions.setList).toHaveBeenCalledWith("workspaceIds", [])
    await user.click(
      screen.getByRole("button", { name: 'remove:{"name":"activity.options.month"}' })
    )
    expect(actions.setActivity).toHaveBeenCalledWith("any")
  })

  it("replaces the facet breakdown with one preset chip when the active filters match a preset", async () => {
    const user = userEvent.setup()
    const preset = {
      id: "p1",
      name: "Focus",
      filters: { unread: true, pinned: true },
      createdAt: 1,
    }
    const { actions } = chips({
      presets: [preset],
      activePreset: preset,
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, pinned: true },
      activeFilters: 2,
    })
    const root = screen.getByTestId("conversation-filter-chips")
    expect(root).toHaveTextContent("Focus")
    expect(root).not.toHaveTextContent("filters.options.unread")
    await user.click(screen.getByRole("button", { name: 'remove:{"name":"Focus"}' }))
    expect(actions.reset).toHaveBeenCalled()
  })

  it("shows the shown/total count and clears every filter in one click", async () => {
    const user = userEvent.setup()
    const { actions } = chips(
      { filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true }, activeFilters: 1 },
      { shown: 3, total: 12 }
    )
    expect(screen.getByTestId("conversation-filter-chips-count")).toHaveTextContent(
      'count:{"shown":3,"total":12}'
    )
    await user.click(screen.getByRole("button", { name: "clearAll" }))
    expect(actions.reset).toHaveBeenCalled()
  })
})
