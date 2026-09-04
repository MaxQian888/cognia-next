/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"

import { AutomationUnavailableNotice } from "./automation-unavailable-notice"

function renderNotice() {
  return render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AutomationUnavailableNotice />
    </NextIntlClientProvider>
  )
}

describe("AutomationUnavailableNotice", () => {
  it("renders the translated title and description", () => {
    renderNotice()
    const notice = screen.getByTestId("automation-unavailable")
    const copy = en.automation.unavailable
    expect(notice).toHaveTextContent(copy.title)
    expect(notice).toHaveTextContent(copy.description)
  })

  /**
   * This notice reaches the mobile Computer Use page, where the old Overview
   * copy told the reader to run `pnpm tauri dev`. A build command is not an
   * action anyone holding a phone can take.
   */
  it("names no developer commands", () => {
    renderNotice()
    const text = screen.getByTestId("automation-unavailable").textContent ?? ""
    expect(text).not.toMatch(/pnpm|tauri dev|tauri build|npm run/i)
  })
})
