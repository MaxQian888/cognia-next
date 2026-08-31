import { act, fireEvent, render, screen } from "@testing-library/react"

let catalogDefinitions: Array<Record<string, unknown>> = []
const mockPreflight = jest.fn()
const mockInstantiate = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "mobile" }))
jest.mock("@/hooks/use-template-catalog", () => ({
  useTemplateCatalog: () => ({ definitions: catalogDefinitions, revision: 0 }),
}))
jest.mock("@/lib/templates/runtime", () => ({
  getTemplateRuntime: () => ({
    service: {
      preflight: (...args: unknown[]) => mockPreflight(...args),
      instantiate: (...args: unknown[]) => mockInstantiate(...args),
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

describe("TemplatesMobileBody", () => {
  beforeEach(() => {
    catalogDefinitions = []
    mockPreflight.mockReset()
    mockInstantiate.mockReset()
  })

  it("preflights and instantiates the template a tap opened", async () => {
    catalogDefinitions = [definition()]
    mockPreflight.mockResolvedValue({ status: "ready", issues: [], operations: [] })
    mockInstantiate.mockResolvedValue({})

    render(<TemplatesMobileBody />)
    fireEvent.click(screen.getByText("Notes"))
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

    render(<TemplatesMobileBody />)
    fireEvent.click(screen.getByText("Notes"))

    expect(screen.getByTestId("templates-mobile-read-only")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "actions.preflight" })).not.toBeInTheDocument()
  })

  it("reports a failing preflight instead of leaving the sheet silent", async () => {
    catalogDefinitions = [definition()]
    mockPreflight.mockRejectedValue(new Error("adapter is unavailable"))

    render(<TemplatesMobileBody />)
    fireEvent.click(screen.getByText("Notes"))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "actions.preflight" }))
    })

    expect(screen.getByText("adapter is unavailable")).toBeInTheDocument()
  })
})
