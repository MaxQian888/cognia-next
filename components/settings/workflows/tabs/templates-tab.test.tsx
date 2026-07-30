/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { TemplatesTab } from "./templates-tab"

const mockPush = jest.fn()
const mockPreflight = jest.fn()
const mockInstantiate = jest.fn()
let mockDefinitions: unknown[] = []
let mockLegacyTemplates: unknown[] = []

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockLegacyTemplates,
}))

jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => "web",
}))

jest.mock("@/hooks/use-template-catalog", () => ({
  useTemplateCatalog: () => ({ definitions: mockDefinitions, revision: 1 }),
}))

jest.mock("@/lib/templates/runtime", () => ({
  getTemplateRuntime: () => ({
    service: {
      preflight: mockPreflight,
      instantiate: mockInstantiate,
    },
  }),
}))

jest.mock("@/components/workflow/library/workflow-card", () => ({
  WorkflowCard: ({ workflow }: { workflow: { name: string } }) => <div>{workflow.name}</div>,
}))

describe("workflow template library", () => {
  beforeEach(() => {
    mockDefinitions = []
    mockLegacyTemplates = []
    mockPush.mockReset()
    mockPreflight.mockReset()
    mockInstantiate.mockReset()
  })

  it("falls back to legacy workflow templates while the unified catalog is empty", () => {
    mockLegacyTemplates = [{ id: "legacy", name: "Legacy workflow" }]

    render(<TemplatesTab />)

    expect(screen.getByText("Legacy workflow")).toBeInTheDocument()
  })

  it("instantiates a ready unified workflow template through the shared service", async () => {
    const definition = {
      id: "workflow.review",
      version: "1.0.0",
      revision: 1,
      contentHash: "a".repeat(64),
      metadata: { name: "Review flow", description: "Review changes" },
      provenance: { trust: "verified-publisher" },
    }
    mockDefinitions = [definition]
    const plan = { id: "plan", status: "ready" }
    mockPreflight.mockResolvedValue(plan)
    mockInstantiate.mockResolvedValue({
      resources: [{ domain: "workflow", id: "workflow-created" }],
    })

    render(<TemplatesTab />)
    fireEvent.click(screen.getByRole("button", { name: "Create workflow" }))

    await waitFor(() => expect(mockInstantiate).toHaveBeenCalledWith({ plan, confirmed: false }))
    expect(mockPush).toHaveBeenCalledWith("/workflows/editor?id=workflow-created")
  })
})
