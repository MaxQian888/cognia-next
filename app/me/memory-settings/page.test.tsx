/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/settings/sections/memory-section", () => ({
  MemorySection: () => <div data-testid="stub-memory-settings" />,
}))

import Page from "./page"

describe("MobileMemorySettingsPage", () => {
  it("renders the Memory settings section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-memory-settings-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-memory-settings")).toBeInTheDocument()
  })
})
