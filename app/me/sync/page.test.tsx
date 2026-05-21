/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/mobile/me/sync-status-panel", () => ({
  SyncStatusPanel: () => <div data-testid="stub-sync-panel" />,
}))

import Page from "./page"

describe("MobileSyncPage", () => {
  it("renders the SubPageShell with the sync panel inside", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-sync-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-sync-panel")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-sub-page-back")).toHaveAttribute(
      "aria-label",
      "appearanceBackAria"
    )
  })
})
