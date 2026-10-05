/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))
jest.mock("@/lib/account-sync/feature-flag", () => ({ accountSyncEnabled: jest.fn(() => false) }))

import { render, screen } from "@testing-library/react"

import { accountSyncEnabled } from "@/lib/account-sync/feature-flag"

import { AccountSyncSummary } from "./account-sync-summary"

describe("AccountSyncSummary", () => {
  it("names account sync as not in this build when the flag is off", () => {
    render(<AccountSyncSummary />)
    expect(screen.getByTestId("account-sync-not-in-build")).toHaveTextContent("notInBuild")
  })

  it("says nothing when the build has account sync", () => {
    jest.mocked(accountSyncEnabled).mockReturnValue(true)
    const { container } = render(<AccountSyncSummary />)
    expect(container).toBeEmptyDOMElement()
  })
})
