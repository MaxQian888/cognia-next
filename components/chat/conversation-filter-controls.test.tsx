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
  ConversationSearchScopeControl,
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
    setGroupBy: jest.fn(),
    setSearchOptions: jest.fn(),
    applyView: jest.fn(),
    clearView: jest.fn(),
    revertView: jest.fn(),
    saveView: jest.fn((): string | null => "new-id"),
    updateView: jest.fn(),
    renameView: jest.fn(),
    removeView: jest.fn(),
    restoreView: jest.fn(),
  }
  const model: ConversationFilterViewModel = {
    filters: EMPTY_CONVERSATION_FILTERS,
    activeFilters: 0,
    sortBy: "recent",
    groupBy: "workspace",
    search: { workspace: "current", includeArchived: false, content: false },
    options: EMPTY_CONVERSATION_FILTER_OPTIONS,
    views: [],
    activeView: undefined,
    activeViewDrift: [],
    hiddenViewIds: [],
    suggestedViewDimensions: [],
    scopeOwnsKind: false,
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

/**
 * The two families a section can be nested under. `sort` is top level, so it is
 * not here (`lib/chat/conversation-filter-families.ts` owns the fold).
 */
const FAMILY_OF: Record<string, "refine" | "scope"> = {
  status: "refine",
  activity: "refine",
  location: "scope",
  agent: "scope",
  model: "scope",
}

/**
 * Walk to a facet section, whichever depth the fold put it at. A family that
 * ended up with one section collapses back to the top level, so the walk has to
 * ask what is on screen rather than assume two levels everywhere.
 */
async function openSection(_user: ReturnType<typeof userEvent.setup>, key: string) {
  const family = FAMILY_OF[key]
  if (family) {
    const familyRow = screen.queryByTestId(`conversation-filter-trigger-family-${family}`)
    // A sub-trigger opens on click as well as on hover, and click is the only
    // one jsdom can drive two levels deep: `user.hover` on a nested trigger
    // reads as "the pointer left the parent submenu" against zero-size rects
    // and closes the level above before the child can open.
    if (familyRow) pick(familyRow)
  }
  const section = await screen.findByTestId(`conversation-filter-trigger-section-${key}`)
  pick(section)
  return section
}

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
    // Four rows, not seven: saved views, sort, and one family per question.
    // `scope` is absent entirely because nothing on this install has a
    // workspace, agent or model to offer.
    const rows = within(content).getAllByRole("menuitem")
    expect(rows.map((r) => r.textContent)).toEqual([
      "views.label",
      "sort.labelsort.options.recent",
      "families.refine",
    ])
    expect(screen.queryByTestId("conversation-filter-trigger-section-location")).toBeNull()
    expect(screen.queryByTestId("conversation-filter-trigger-family-scope")).toBeNull()
  })

  it("lists the location / agent / model sections once options exist, with per-section counts", async () => {
    const user = userEvent.setup()
    menu({
      options: richOptions,
      filters: { ...EMPTY_CONVERSATION_FILTERS, workspaceIds: ["w1"], models: ["claude"] },
      activeFilters: 2,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    // Three facet lists, one family row. The count on the family is the sum of
    // what is nested under it, so the fold hides no active filter.
    const family = await screen.findByTestId("conversation-filter-trigger-family-scope")
    expect(within(family).getByTestId("conversation-filter-section-count")).toHaveTextContent("2")
    await user.hover(family)
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
    await openSection(user, "sort")
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
    await openSection(user, "status")
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

  it("drops the kind group on a surface whose own scope already decides it", async () => {
    // The desktop rail's guild rows scope the list to Chats or to one team, and
    // the controller stops applying `kind` there — so offering it would put a
    // control on screen whose every option changes nothing. The boolean quick
    // filters beside it are unaffected.
    const user = userEvent.setup()
    menu({ scopeOwnsKind: true })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await openSection(user, "status")
    expect(
      await screen.findByRole("menuitemcheckbox", { name: "filters.options.unread" })
    ).toBeInTheDocument()
    expect(screen.queryByText("kind.label")).toBeNull()
    expect(screen.queryByRole("menuitemradio", { name: "kind.options.team" })).toBeNull()
  })

  it("offers an 'any' row plus counted values for each list facet, using the unassigned label", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      options: richOptions,
      filters: { ...EMPTY_CONVERSATION_FILTERS, workspaceIds: ["w1"] },
      activeFilters: 1,
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await openSection(user, "location")
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
    await openSection(user, "activity")
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

  const customView = (id: string, name: string, overlay: Record<string, unknown>) => ({
    id,
    name,
    builtIn: false,
    createdAt: 1,
    overlay,
  })

  it("lists views, marks the active one, applies on click and gates 'save'", async () => {
    const user = userEvent.setup()
    const views = [
      customView("p1", "Unread", { filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true } }),
      customView("p2", "Teams", { filters: { ...EMPTY_CONVERSATION_FILTERS, kind: "team" } }),
    ] as ConversationFilterViewModel["views"]
    const { actions } = menu({
      views,
      activeView: views[1],
      activeViewDrift: [],
      filters: { ...EMPTY_CONVERSATION_FILTERS, kind: "team" },
      activeFilters: 1,
      suggestedViewDimensions: ["filters"],
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const row = await screen.findByRole("menuitem", { name: /views\.label/ })
    expect(row).toHaveTextContent("Teams")
    await user.hover(row)
    const teams = await screen.findByRole("menuitemcheckbox", { name: "Teams" })
    expect(teams).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("menuitemcheckbox", { name: "Unread" })).toHaveAttribute(
      "aria-checked",
      "false"
    )
    // Sitting inside an unmodified view → it is already saved.
    expect(screen.getByRole("menuitem", { name: "views.save" })).toHaveAttribute(
      "aria-disabled",
      "true"
    )
    expect(screen.getByRole("menuitem", { name: "views.manage" })).toBeInTheDocument()
    pick(screen.getByRole("menuitemcheckbox", { name: "Unread" }))
    expect(actions.applyView).toHaveBeenCalledWith("p1")
  })

  it("offers revert and update only once the active view has drifted", async () => {
    const user = userEvent.setup()
    const views = [
      customView("p1", "Unread", { sortBy: "unread" }),
    ] as ConversationFilterViewModel["views"]
    const { actions } = menu({
      views,
      activeView: views[0],
      activeViewDrift: ["sortBy"],
      sortBy: "title",
      suggestedViewDimensions: ["sortBy"],
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /views\.label/ }))
    pick(await screen.findByTestId("conversation-filter-trigger-view-revert"))
    expect(actions.revertView).toHaveBeenCalled()
  })

  it("does not offer 'update' for a built-in view — those are code, not data", async () => {
    const user = userEvent.setup()
    const views = [
      {
        id: "builtin:unread",
        name: "views.builtIn.unread",
        builtIn: true,
        createdAt: 0,
        overlay: { sortBy: "unread" },
      },
    ] as ConversationFilterViewModel["views"]
    menu({
      views,
      activeView: views[0],
      activeViewDrift: ["sortBy"],
      sortBy: "title",
      suggestedViewDimensions: ["sortBy"],
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /views\.label/ }))
    expect(await screen.findByTestId("conversation-filter-trigger-view-revert")).toBeInTheDocument()
    expect(screen.queryByTestId("conversation-filter-trigger-view-update")).toBeNull()
  })

  it("saves the current state as a named view, pinning the ticked dimensions", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true },
      activeFilters: 1,
      suggestedViewDimensions: ["filters"],
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /views\.label/ }))
    expect(await screen.findByText("views.empty")).toBeInTheDocument()
    pick(screen.getByRole("menuitem", { name: "views.save" }))
    const dialog = await screen.findByTestId("conversation-view-save-dialog")
    expect(within(dialog).getByRole("button", { name: "views.saveAction" })).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox"), "Mine")
    // The suggestion is pre-ticked; add the sort so two dimensions travel.
    await user.click(
      within(within(dialog).getByTestId("conversation-view-dimension-sortBy")).getByRole("checkbox")
    )
    await user.click(within(dialog).getByRole("button", { name: "views.saveAction" }))
    expect(actions.saveView).toHaveBeenCalledWith("Mine", ["filters", "sortBy"])
    expect(screen.queryByTestId("conversation-view-save-dialog")).toBeNull()
  })

  it("refuses to save with nothing pinned", async () => {
    const user = userEvent.setup()
    const { actions } = menu({ sortBy: "title", suggestedViewDimensions: ["sortBy"] })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /views\.label/ }))
    pick(await screen.findByRole("menuitem", { name: "views.save" }))
    const dialog = await screen.findByTestId("conversation-view-save-dialog")
    await user.type(within(dialog).getByRole("textbox"), "Mine")
    // Untick the only suggestion — a view that pins nothing is a no-op button.
    await user.click(
      within(within(dialog).getByTestId("conversation-view-dimension-sortBy")).getByRole("checkbox")
    )
    expect(within(dialog).getByRole("button", { name: "views.saveAction" })).toBeDisabled()
    expect(actions.saveView).not.toHaveBeenCalled()
  })

  it("keeps the save dialog open with an error when the controller refuses the view", async () => {
    const user = userEvent.setup()
    const { actions } = menu({
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true },
      activeFilters: 1,
      suggestedViewDimensions: ["filters"],
    })
    actions.saveView.mockReturnValue(null)
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /views\.label/ }))
    pick(await screen.findByRole("menuitem", { name: "views.save" }))
    const dialog = await screen.findByTestId("conversation-view-save-dialog")
    await user.type(within(dialog).getByRole("textbox"), "x")
    await user.keyboard("{Enter}")
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("views.saveRejected")
    expect(screen.getByTestId("conversation-view-save-dialog")).toBeInTheDocument()
  })

  it("renames and deletes custom views from the manage dialog", async () => {
    const user = userEvent.setup()
    const views = [
      customView("p1", "Unread", { filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true } }),
      customView("p2", "Teams", { filters: { ...EMPTY_CONVERSATION_FILTERS, kind: "team" } }),
    ] as ConversationFilterViewModel["views"]
    const { actions } = menu({ views })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /views\.label/ }))
    pick(await screen.findByRole("menuitem", { name: "views.manage" }))
    const dialog = await screen.findByTestId("conversation-view-manage-dialog")
    const rename = within(dialog).getByRole("textbox", { name: 'views.rename:{"name":"Unread"}' })
    await user.clear(rename)
    await user.type(rename, "Unread only{Enter}")
    expect(actions.renameView).toHaveBeenCalledWith("p1", "Unread only")

    await user.click(within(dialog).getByRole("button", { name: 'views.delete:{"name":"Unread"}' }))
    expect(actions.removeView).toHaveBeenCalledWith("p1")
  })

  it("hides rather than deletes a built-in view, and offers to restore it", async () => {
    const user = userEvent.setup()
    const views = [
      {
        id: "builtin:unread",
        name: "views.builtIn.unread",
        builtIn: true,
        createdAt: 0,
        overlay: { sortBy: "unread" },
      },
    ] as ConversationFilterViewModel["views"]
    const { actions } = menu({ views, hiddenViewIds: ["builtin:globalSearch"] })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    await user.hover(await screen.findByRole("menuitem", { name: /views\.label/ }))
    pick(await screen.findByRole("menuitem", { name: "views.manage" }))
    const dialog = await screen.findByTestId("conversation-view-manage-dialog")
    // A built-in's name is a translation key, so there is no rename field.
    expect(within(dialog).queryByRole("textbox")).toBeNull()
    await user.click(
      within(dialog).getByRole("button", { name: 'views.hide:{"name":"views.builtIn.unread"}' })
    )
    expect(actions.removeView).toHaveBeenCalledWith("builtin:unread")
    await user.click(within(dialog).getByTestId("conversation-view-restore-builtin:globalSearch"))
    expect(actions.restoreView).toHaveBeenCalledWith("builtin:globalSearch")
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
    // The same fold the dropdown draws: sort at the top level, then one row
    // per family. Sort and the narrowing family start open, the facet lists
    // stay folded because their length is install-specific.
    expect(within(drawer).getByTestId("conversation-filter-trigger-section-sort")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    expect(within(drawer).getByTestId("conversation-filter-trigger-family-refine")).toHaveAttribute(
      "aria-expanded",
      "true"
    )
    const scope = within(drawer).getByTestId("conversation-filter-trigger-family-scope")
    expect(scope).toHaveAttribute("aria-expanded", "false")
    expect(within(drawer).queryByTestId("conversation-filter-trigger-section-location")).toBeNull()
    tap(within(drawer).getByRole("radio", { name: "sort.options.title" }))
    expect(actions.setSortBy).toHaveBeenCalledWith("title")
    tap(within(drawer).getByRole("checkbox", { name: "filters.options.unread" }))
    expect(actions.toggle).toHaveBeenCalledWith("unread", true)

    // One tap to a workspace, because a family opens onto its first section
    // rather than onto more closed rows. The touch target is unchanged.
    tap(scope)
    expect(
      await within(drawer).findByTestId("conversation-filter-trigger-section-location")
    ).toHaveAttribute("aria-expanded", "true")
    const alpha = await within(drawer).findByRole("checkbox", { name: /Alpha/ })
    expect(alpha.closest("label")).toHaveClass("min-h-11")
    tap(alpha)
    expect(actions.toggleValue).toHaveBeenCalledWith("workspaceIds", "w1", true)
  })

  it("shows views as tappable chips and routes save / manage to the dialogs", async () => {
    const user = userEvent.setup()
    const views = [
      {
        id: "p1",
        name: "Unread",
        builtIn: false,
        createdAt: 1,
        overlay: { filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true } },
      },
    ] as ConversationFilterViewModel["views"]
    const { actions } = menu({
      views,
      filters: { ...EMPTY_CONVERSATION_FILTERS, pinned: true },
      activeFilters: 1,
      suggestedViewDimensions: ["filters"],
    })
    await user.click(screen.getByTestId("conversation-filter-trigger"))
    const drawer = await screen.findByTestId("conversation-filter-trigger-drawer")
    tap(within(drawer).getByRole("button", { name: "Unread" }))
    expect(actions.applyView).toHaveBeenCalledWith("p1")
    tap(within(drawer).getByRole("button", { name: "views.manage" }))
    expect(await screen.findByTestId("conversation-view-manage-dialog")).toBeInTheDocument()
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

  it("replaces the facet breakdown with one chip while a view is exactly in effect", async () => {
    const user = userEvent.setup()
    const view = {
      id: "p1",
      name: "Focus",
      builtIn: false,
      createdAt: 1,
      overlay: { filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, pinned: true } },
    } as ConversationFilterViewModel["views"][number]
    const { actions } = chips({
      views: [view],
      activeView: view,
      activeViewDrift: [],
      filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true, pinned: true },
      activeFilters: 2,
    })
    const root = screen.getByTestId("conversation-filter-chips")
    expect(root).toHaveTextContent("Focus")
    expect(root).not.toHaveTextContent("filters.options.unread")
    // The × leaves the view; it does not clear the filters the view pinned.
    await user.click(screen.getByRole("button", { name: "views.clear" }))
    expect(actions.clearView).toHaveBeenCalled()
    expect(actions.reset).not.toHaveBeenCalled()
  })

  it("says 'modified' once the view has drifted, and offers the way back", async () => {
    const user = userEvent.setup()
    const view = {
      id: "p1",
      name: "Focus",
      builtIn: false,
      createdAt: 1,
      overlay: { filters: { ...EMPTY_CONVERSATION_FILTERS, unread: true } },
    } as ConversationFilterViewModel["views"][number]
    const { actions } = chips({
      views: [view],
      activeView: view,
      activeViewDrift: ["filters"],
      filters: { ...EMPTY_CONVERSATION_FILTERS, pinned: true },
      activeFilters: 1,
    })
    const root = screen.getByTestId("conversation-filter-chips")
    expect(screen.getByTestId("conversation-filter-chips-view-modified")).toHaveTextContent(
      'views.modifiedChip:{"name":"Focus"}'
    )
    // Drifted → the facets are shown again, because they are no longer the
    // view's own and the user has to be able to see what moved.
    expect(root).toHaveTextContent("filters.options.pinned")
    await user.click(screen.getByRole("button", { name: 'views.modifiedChip:{"name":"Focus"}' }))
    expect(actions.revertView).toHaveBeenCalled()
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

describe("ConversationSearchScopeControl", () => {
  const scope = (overrides: Partial<ConversationFilterViewModel> = {}) => {
    const { model, actions } = makeModel(overrides)
    render(<ConversationSearchScopeControl model={model} />)
    return { model, actions }
  }

  it("renders no badge while every axis is at its default", () => {
    scope()
    expect(screen.getByTestId("conversation-search-scope")).toBeInTheDocument()
    expect(screen.queryByTestId("conversation-search-scope-dot")).toBeNull()
  })

  it("counts each widened axis on the badge, so a reach left on is never invisible", () => {
    scope({ search: { workspace: "all", includeArchived: true, content: false } })
    expect(screen.getByTestId("conversation-search-scope-dot")).toHaveTextContent("2")
  })

  it("writes one axis at a time and leaves the menu open", async () => {
    const user = userEvent.setup()
    const { actions } = scope({
      search: { workspace: "all", includeArchived: false, content: false },
    })
    await user.click(screen.getByTestId("conversation-search-scope"))
    const menuContent = await screen.findByTestId("conversation-search-scope-menu")
    pick(within(menuContent).getByTestId("conversation-search-scope-archived"))
    expect(actions.setSearchOptions).toHaveBeenCalledWith({ includeArchived: true })
    // Composing a reach, not firing a command.
    expect(screen.getByTestId("conversation-search-scope-menu")).toBeInTheDocument()
  })

  it("marks the current workspace reach and can widen it", async () => {
    const user = userEvent.setup()
    const { actions } = scope()
    await user.click(screen.getByTestId("conversation-search-scope"))
    const menuContent = await screen.findByTestId("conversation-search-scope-menu")
    expect(
      within(menuContent).getByTestId("conversation-search-scope-workspace-current")
    ).toHaveAttribute("aria-checked", "true")
    pick(within(menuContent).getByTestId("conversation-search-scope-workspace-all"))
    expect(actions.setSearchOptions).toHaveBeenCalledWith({ workspace: "all" })
  })

  it("only explains the message-index minimum once content search is on", async () => {
    const user = userEvent.setup()
    scope({ search: { workspace: "current", includeArchived: false, content: true } })
    await user.click(screen.getByTestId("conversation-search-scope"))
    expect(await screen.findByText(/searchScope\.contentHint/)).toBeInTheDocument()
  })
})
