jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn(async () => {}) }))

import { fireEvent, render, screen } from "@testing-library/react"

import { openExternal } from "@/lib/tauri/opener"

import { StatusExternalLink } from "./status-link"

describe("StatusExternalLink", () => {
  it("is a plain new-tab link on the hosted page", () => {
    render(
      <StatusExternalLink href="https://status.example/feed.atom" mode="primary">
        Feed
      </StatusExternalLink>
    )
    const link = screen.getByRole("link", { name: "Feed" })
    expect(link).toHaveAttribute("href", "https://status.example/feed.atom")
    expect(link).toHaveAttribute("rel", "noopener noreferrer")
    fireEvent.click(link)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it("opens through the cross-platform opener inside Cognia", () => {
    render(
      <StatusExternalLink href="https://status.cognia.cn/status/" mode="app">
        Status
      </StatusExternalLink>
    )
    fireEvent.click(screen.getByRole("link", { name: "Status" }))
    expect(openExternal).toHaveBeenCalledWith("https://status.cognia.cn/status/")
  })
})
