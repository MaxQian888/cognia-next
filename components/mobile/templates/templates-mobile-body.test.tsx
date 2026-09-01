import { act, fireEvent, render, screen } from "@testing-library/react"

let catalogDefinitions: Array<Record<string, unknown>> = []
const mockPreflight = jest.fn()
const mockInstantiate = jest.fn()
const mockFork = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "mobile" }))
jest.mock("@/hooks/use-template-catalog", () => ({
  useTemplateCatalog: () => ({ definitions: catalogDefinitions, revision: 0 }),
}))
/**
 * Selection and filters live in the URL now, shared with the desktop Studio so
 * one link means the same thing on both. A router mock that discarded the write
 * would leave the sheet permanently shut, so this one round-trips it.
 */
let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => {
      searchParams = new URLSearchParams(href.split("?")[1] ?? "")
    },
  }),
  usePathname: () => "/templates",
  useSearchParams: () => searchParams,
}))
jest.mock("@/hooks/templates/use-scoped-template-catalog", () => ({
  useScopedTemplateCatalog: () => ({
    definitions: catalogDefinitions,
    owners: {},
    tierOf: () => "mine",
    hiddenCount: 0,
    revision: 0,
  }),
}))
jest.mock("@/lib/templates/runtime", () => ({
  getTemplateRuntime: () => ({
    service: {
      preflight: (...args: unknown[]) => mockPreflight(...args),
      instantiate: (...args: unknown[]) => mockInstantiate(...args),
      fork: (...args: unknown[]) => mockFork(...args),
      // The sheet asks whether this template was forked, so it can show where
      // it came from. Nothing here is, by default.
      getDerivation: async () => undefined,
    },
  }),
}))

import { TemplatesMobileBody } from "./templates-mobile-body"

function definition(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: "cognia.dev/templates/v1",
    id: "user.skill.notes",
    domain: "skill",
    version: "1.0.0",
    status: "published",
    revision: 1,
    metadata: { name: "Notes", description: "Take notes" },
    payload: { name: "Notes", content: "" },
    inputs: [{ id: "title", label: "Title", kind: "string", required: true }],
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: ["mobile"] },
    provenance: { source: "user", trust: "unsigned" },
    contentHash: "sha256:notes",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

/**
 * Opening a template is a navigation now, not local state. The router mock
 * records the new query string, and only a re-render lets the component read it
 * back, which is exactly what the real router does through its own subscription.
 */
function openCard(view: { rerender: (ui: React.ReactElement) => void }, name: string) {
  fireEvent.click(screen.getByText(name))
  view.rerender(<TemplatesMobileBody />)
}

describe("TemplatesMobileBody", () => {
  beforeEach(() => {
    catalogDefinitions = []
    searchParams = new URLSearchParams()
    mockPreflight.mockReset()
    mockInstantiate.mockReset()
    mockFork.mockReset()
  })

  it("preflights and instantiates the template a tap opened", async () => {
    catalogDefinitions = [definition()]
    mockPreflight.mockResolvedValue({ status: "ready", issues: [], operations: [] })
    mockInstantiate.mockResolvedValue({})

    const view = render(<TemplatesMobileBody />)
    openCard(view, "Notes")
    // The binding field is the shared typed control, so a phone gets the same
    // picker set the desktop inspector does rather than a second text box.
    expect(screen.getByTestId("template-binding-title")).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "actions.preflight" }))
    })
    expect(mockPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ definitionId: "user.skill.notes", version: "1.0.0" })
    )

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "actions.instantiate" }))
    })
    expect(mockInstantiate).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true })
    )
    expect(screen.getByText("messages.instantiated")).toBeInTheDocument()
  })

  it("offers no instantiate path for a catalog-only domain", () => {
    catalogDefinitions = [definition({ domain: "prompt" })]

    const view = render(<TemplatesMobileBody />)
    openCard(view, "Notes")

    expect(screen.getByTestId("templates-mobile-read-only")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.preflight" })).not.toBeInTheDocument()
  })

  it("reports a failing preflight instead of leaving the sheet silent", async () => {
    catalogDefinitions = [definition()]
    mockPreflight.mockRejectedValue(new Error("adapter is unavailable"))

    const view = render(<TemplatesMobileBody />)
    openCard(view, "Notes")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "actions.preflight" }))
    })

    expect(screen.getByText("adapter is unavailable")).toBeInTheDocument()
  })

  /**
   * Fork is the one authoring-adjacent verb a phone gets. It needs no editor:
   * it drops a copy in your own library with its origin recorded, ready to edit
   * on a desktop and updatable against upstream in the meantime.
   */
  it("forks a template into your own library", async () => {
    catalogDefinitions = [definition()]
    mockFork.mockResolvedValue({ id: "user.skill.notes-copy.abc" })

    const view = render(<TemplatesMobileBody />)
    openCard(view, "Notes")
    await act(async () => {
      fireEvent.click(screen.getByTestId("templates-mobile-fork"))
    })

    expect(mockFork).toHaveBeenCalledWith(
      "user.skill.notes",
      expect.objectContaining({ version: "1.0.0" })
    )
    expect(screen.getByTestId("templates-mobile-message")).toBeInTheDocument()
  })

  /**
   * The controls that are not here are named rather than merely absent. A
   * missing button reads as a bug, where "this happens on the desktop" does not.
   */
  it("says where authoring lives instead of silently omitting it", () => {
    catalogDefinitions = [definition()]
    const view = render(<TemplatesMobileBody />)
    openCard(view, "Notes")

    expect(screen.getByTestId("templates-mobile-authoring")).toBeInTheDocument()
  })

  /** A deep link has to land on the template, the way it does on the desktop. */
  it("opens the template a link named", () => {
    catalogDefinitions = [definition()]
    searchParams = new URLSearchParams("definition=user.skill.notes")

    render(<TemplatesMobileBody />)
    expect(screen.getByTestId("template-binding-title")).toBeInTheDocument()
  })

  it("carries the search term in the URL so a narrowed list can be shared", () => {
    catalogDefinitions = [definition()]
    render(<TemplatesMobileBody />)
    fireEvent.change(screen.getByLabelText("filters.search"), { target: { value: "notes" } })

    expect(searchParams.get("q")).toBe("notes")
  })
})
