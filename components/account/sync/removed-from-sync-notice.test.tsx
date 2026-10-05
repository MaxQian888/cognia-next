/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => jest.requireActual("./test-intl").echoTranslations(),
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { RemovedFromSyncNotice } from "./removed-from-sync-notice"

describe("RemovedFromSyncNotice", () => {
  it("says when this device was removed and offers to join again", () => {
    const onRejoin = jest.fn()
    render(
      <RemovedFromSyncNotice
        removal={{ at: Date.UTC(2026, 9, 5), seq: 3, by: "dev_X" }}
        onRejoin={onRejoin}
      />
    )
    expect(screen.getByTestId("account-sync-removed")).toHaveTextContent("title")
    expect(screen.getByTestId("account-sync-removed")).toHaveTextContent(
      new Date(Date.UTC(2026, 9, 5)).toLocaleString()
    )
    fireEvent.click(screen.getByTestId("account-sync-rejoin"))
    expect(onRejoin).toHaveBeenCalled()
  })
})
