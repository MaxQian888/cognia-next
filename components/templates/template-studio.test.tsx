import { act, fireEvent, render, screen } from "@testing-library/react"

let catalogDefinitions: Array<Record<string, unknown>> = []

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => "mobile" }))
jest.mock("@/hooks/use-template-catalog", () => ({
  useTemplateCatalog: () => ({ definitions: catalogDefinitions, revision: 0 }),
}))
jest.mock("@/lib/templates/runtime", () => ({
  getTemplateRuntime: () => ({
    repository: {
      listPackages: async () => [],
      listInstances: async () => [],
    },
    service: {},
  }),
}))

import { TemplateStudio } from "./template-studio"

describe("TemplateStudio", () => {
  beforeEach(() => {
    catalogDefinitions = []
    window.history.replaceState({}, "", "/templates")
  })

  it("keeps mobile browsing available while replacing authoring with a desktop handoff", async () => {
    await act(async () => {
      render(<TemplateStudio />)
    })

    expect(screen.getByTestId("template-studio")).toBeInTheDocument()
    expect(screen.getByText("mobile.title")).toBeInTheDocument()
    expect(screen.queryByText("actions.newDraft")).not.toBeInTheDocument()
    expect(screen.getByText("tabs.library")).toBeInTheDocument()
  })

  it("selects a catalog definition from a deep link", async () => {
    catalogDefinitions = [
      {
        apiVersion: "cognia.dev/templates/v1",
        id: "team.review",
        domain: "agentTeam",
        version: "1.0.0",
        status: "published",
        revision: 1,
        metadata: { name: "Review Team", description: "Review changes" },
        payload: {},
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["mobile"] },
        provenance: { source: "user", trust: "unsigned" },
        contentHash: "sha256:review",
        baselineHash: "sha256:review",
        createdAt: "2026-07-30T00:00:00.000Z",
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    ]
    window.history.replaceState({}, "", "/templates?definition=team.review")

    await act(async () => {
      render(<TemplateStudio />)
    })

    expect(screen.getByText("team.review@1.0.0")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "inspector.payload" }))
    expect(screen.getByText("{}")).toBeInTheDocument()
  })
})
