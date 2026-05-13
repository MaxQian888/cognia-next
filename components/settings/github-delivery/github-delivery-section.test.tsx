import { render, screen } from "@testing-library/react"
import { GithubDeliverySection } from "./github-delivery-section"

// next/navigation is mocked in jest.setup.ts; we re-mock useSearchParams to
// override the tab value per test.
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => ({
    get: (key: string) => (key === "ghTab" ? mockTab : null),
    entries: () => [].values(),
  }),
}))

// dexie-react-hooks: useLiveQuery is async — return null by default so the
// tabs render their empty-state.
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => null,
}))

// getDb throws in jsdom because there's no real IndexedDB layer plugged in;
// the tabs already swallow that into the empty state.
jest.mock("@/lib/db/schema", () => ({
  getDb: () => {
    throw new Error("no db in tests")
  },
}))

let mockTab: string | null = null

describe("GithubDeliverySection", () => {
  beforeEach(() => {
    mockTab = null
  })

  it("renders the heading and all 5 tabs", () => {
    render(<GithubDeliverySection />)
    expect(screen.getByText("GitHub Delivery")).toBeInTheDocument()
    // Every tab trigger is in the DOM.
    expect(screen.getByRole("tab", { name: "Repos" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Credentials" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Policies" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Audit" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Usage" })).toBeInTheDocument()
  })

  it("defaults to the repos tab when no ghTab query is set", () => {
    render(<GithubDeliverySection />)
    expect(screen.getByTestId("repos-empty")).toBeInTheDocument()
  })

  it("respects ghTab=policies in the URL", () => {
    mockTab = "policies"
    render(<GithubDeliverySection />)
    expect(screen.getByTestId("policies-tab")).toBeInTheDocument()
  })

  it("respects ghTab=usage in the URL", () => {
    mockTab = "usage"
    render(<GithubDeliverySection />)
    expect(screen.getByTestId("usage-tab")).toBeInTheDocument()
  })

  it("ignores invalid ghTab values and falls back to repos", () => {
    mockTab = "nonsense"
    render(<GithubDeliverySection />)
    expect(screen.getByTestId("repos-empty")).toBeInTheDocument()
  })
})
