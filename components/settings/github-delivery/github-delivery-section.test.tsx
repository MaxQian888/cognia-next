import { render, screen } from "@testing-library/react"

// Passthrough i18n: t(key) returns the key, so assertions target stable keys.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

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
    expect(screen.getByText("title")).toBeInTheDocument()
    // Every tab trigger is in the DOM.
    expect(screen.getByRole("tab", { name: "tabs.repos" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.credentials" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.policies" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.audit" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "tabs.usage" })).toBeInTheDocument()
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
