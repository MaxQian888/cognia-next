/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/mobile/backup/mobile-backup-section", () => ({
  MobileBackupSection: () => <div data-testid="stub-backup-section" />,
}))

import Page from "./page"

describe("MobileBackupPage", () => {
  it("renders the backup section inside the shell", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-backup-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-backup-section")).toBeInTheDocument()
  })
})
