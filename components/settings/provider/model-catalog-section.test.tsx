import { fireEvent, render, screen } from "@testing-library/react"

const snapshot = {
  revision: { id: "r1" },
  offerings: [],
  aliases: [
    {
      id: "legacy:gpt-test",
      kind: "legacy",
      target: { type: "model", ref: "openai:gpt-test" },
      replacementRef: "openai:gpt-next",
    },
  ],
}
const searchModels = jest.fn((..._args: unknown[]) => [
  {
    model: {
      id: "openai:gpt-test",
      name: "GPT Test",
      creator: "openai",
      modalities: { input: ["text"], output: ["text"] },
      capabilities: { tools: true },
      lifecycle: "deprecated",
      provenance: {},
    },
    offerings: [
      {
        id: "openai:gpt-test",
        providerRef: "openai",
        modelRef: "openai:gpt-test",
        upstreamId: "gpt-test",
        endpointType: "responses",
        lifecycle: "active",
        available: true,
        source: { kind: "bundled", id: "test" },
      },
    ],
  },
])

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => unknown) => query(),
}))
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 76,
        start: index * 76,
      })),
  }),
}))
jest.mock("@/lib/db/provider-catalog", () => ({
  getCatalogState: () => ({
    id: "singleton",
    activeRevisionId: "r1",
    stagedRevisionIds: [],
  }),
  getActiveCatalogSnapshot: () => snapshot,
  providerCatalogRepository: {
    listProviders: () => [
      {
        id: "openai",
        name: "OpenAI",
        tier: "certified",
      },
    ],
    searchModels: (...args: unknown[]) => searchModels(...args),
  },
}))

import { ModelCatalogSection } from "./model-catalog-section"

describe("ModelCatalogSection", () => {
  beforeEach(() => {
    searchModels.mockClear()
    Object.defineProperty(globalThis, "Worker", { value: undefined, configurable: true })
  })

  it("renders the virtualized catalog, filters, and routed offering id", () => {
    render(<ModelCatalogSection />)

    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument()
    expect(screen.getByPlaceholderText("searchPlaceholder")).toBeInTheDocument()
    expect(screen.getByText("GPT Test")).toBeInTheDocument()

    fireEvent.click(screen.getByText("GPT Test"))

    expect(screen.getByText("routedId: gpt-test")).toBeInTheDocument()
    expect(screen.getByText("OpenAI")).toBeInTheDocument()
    expect(screen.getByText("openai:gpt-next")).toBeInTheDocument()
  })

  it("switches from recommended Certified mode to advanced catalog mode", () => {
    render(<ModelCatalogSection />)

    fireEvent.click(screen.getByRole("switch"))

    expect(searchModels).toHaveBeenLastCalledWith(expect.objectContaining({ tiers: undefined }))
  })
})
