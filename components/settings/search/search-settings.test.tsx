import { render } from "@testing-library/react"

jest.mock("./search-global-settings", () => ({
  SearchGlobalSettings: () => <div data-testid="global" />,
}))
jest.mock("./search-defaults-settings", () => ({
  SearchDefaultsSettings: () => <div data-testid="defaults" />,
}))
jest.mock("./search-cache-settings", () => ({
  SearchCacheSettings: () => <div data-testid="cache" />,
}))
jest.mock("./search-safety-settings", () => ({
  SearchSafetySettings: () => <div data-testid="safety" />,
}))
jest.mock("./source-verification-settings", () => ({
  SourceVerificationSettings: () => <div data-testid="verify" />,
}))
jest.mock("./search-provider-grid", () => ({
  SearchProviderGrid: () => <div data-testid="grid" />,
}))
jest.mock("./search-provider-compare", () => ({
  SearchProviderCompare: () => <div data-testid="compare" />,
}))
jest.mock("./search-usage-panel", () => ({
  SearchUsagePanel: () => <div data-testid="usage" />,
}))

import { SearchSettings } from "./search-settings"

describe("SearchSettings (root)", () => {
  it("renders all 8 sub-panels", () => {
    const { getByTestId } = render(<SearchSettings />)
    expect(getByTestId("global")).toBeInTheDocument()
    expect(getByTestId("defaults")).toBeInTheDocument()
    expect(getByTestId("cache")).toBeInTheDocument()
    expect(getByTestId("safety")).toBeInTheDocument()
    expect(getByTestId("verify")).toBeInTheDocument()
    expect(getByTestId("grid")).toBeInTheDocument()
    expect(getByTestId("compare")).toBeInTheDocument()
    expect(getByTestId("usage")).toBeInTheDocument()
  })
})
