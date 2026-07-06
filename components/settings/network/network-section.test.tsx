/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

// The tabs lazy-load via dynamic import in the section, but next/dynamic
// resolves synchronously enough in jsdom for this smoke test.
jest.mock("./tabs/general-tab", () => ({
  NetworkGeneralTab: () => <div data-testid="general-tab" />,
}))
jest.mock("./tabs/detection-tab", () => ({
  NetworkDetectionTab: () => <div data-testid="detection-tab" />,
}))
jest.mock("./tabs/test-tab", () => ({
  NetworkTestTab: () => <div data-testid="test-tab" />,
}))
jest.mock("./tabs/ip-info-tab", () => ({
  NetworkIpInfoTab: () => <div data-testid="ip-info-tab" />,
}))

import { NetworkSection } from "./network-section"

describe("NetworkSection", () => {
  it("renders the header and all four tabs", () => {
    render(<NetworkSection />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("description")).toBeInTheDocument()
    expect(screen.getByText("tabs.general")).toBeInTheDocument()
    expect(screen.getByText("tabs.detection")).toBeInTheDocument()
    expect(screen.getByText("tabs.test")).toBeInTheDocument()
    expect(screen.getByText("tabs.ipInfo")).toBeInTheDocument()
  })

  it("renders the General tab by default", () => {
    render(<NetworkSection />)
    expect(screen.getByTestId("general-tab")).toBeInTheDocument()
  })
})
