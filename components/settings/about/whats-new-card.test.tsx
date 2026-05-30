/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/lib/constants/release-notes", () => ({
  RELEASES: [
    { version: "0.1.0", date: "2026-05-30", highlightKeys: ["foundation", "crossPlatform"] },
  ],
}))

const openExternalMock = jest.fn(async (_u: string) => {})
jest.mock("@/lib/tauri/opener", () => ({ openExternal: (u: string) => openExternalMock(u) }))

import { WhatsNewCard } from "./whats-new-card"
import { RELEASES_URL } from "@/lib/constants/external-urls"

describe("<WhatsNewCard />", () => {
  it("renders the latest release expanded with translated highlights", () => {
    render(<WhatsNewCard />)
    expect(screen.getByTestId("whatsnew-trigger-0.1.0")).toHaveTextContent("0.1.0")
    // The latest release is open by default; its highlights resolve via i18n.
    expect(screen.getByText("Initial public foundation release")).toBeInTheDocument()
  })

  it("opens the full releases history", () => {
    render(<WhatsNewCard />)
    fireEvent.click(screen.getByTestId("whatsnew-view-all"))
    expect(openExternalMock).toHaveBeenCalledWith(RELEASES_URL)
  })
})
