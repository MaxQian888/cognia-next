/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/mobile/me/storage-usage-card", () => ({
  StorageUsageCard: () => <div data-testid="stub-storage" />,
}))

import Page from "./page"

describe("MobileStoragePage", () => {
  it("renders the storage usage card inside the SubPageShell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-storage-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-storage")).toBeInTheDocument()
  })
})
