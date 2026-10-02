import { fireEvent, render, screen } from "@testing-library/react"

import type { StatusRuntime } from "@/lib/status/public-status"

import { MirrorNotice, RefreshErrorBanner } from "./status-notices"

const mirror: StatusRuntime = {
  mode: "mirror",
  apiBase: "/mirror/api",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: false,
}

describe("MirrorNotice", () => {
  it("warns prominently that a mirror is read-only and possibly stale", () => {
    render(<MirrorNotice runtime={mirror} />)
    expect(screen.getByTestId("mirror-notice")).toHaveTextContent(
      "Read-only mirror, possibly stale"
    )
    expect(screen.getByRole("link", { name: "Open the primary status page" })).toHaveAttribute(
      "href",
      "https://status.cognia.cn/status/"
    )
  })

  it("is absent on the primary page", () => {
    render(<MirrorNotice runtime={{ ...mirror, mode: "primary", allowsConsentWrites: true }} />)
    expect(screen.queryByTestId("mirror-notice")).toBeNull()
  })
})

describe("RefreshErrorBanner", () => {
  it("keeps the original receive time and offers a retry", () => {
    const onRetry = jest.fn()
    render(
      <RefreshErrorBanner
        error={{ kind: "timeout", failures: 1, at: 0 }}
        fetchedAtClientMs={Date.parse("2026-10-02T09:59:00.000Z")}
        onRetry={onRetry}
        refreshing={false}
      />
    )
    const banner = screen.getByTestId("refresh-error")
    expect(banner).toHaveAttribute("role", "alert")
    expect(banner).toHaveTextContent("Status could not be refreshed")
    expect(banner).toHaveTextContent("did not answer in time")
    expect(banner).toHaveTextContent(/last data received Oct 2, 2026.*09:59/)
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetry).toHaveBeenCalled()
  })

  it("asks for a reload after a schema change", () => {
    render(
      <RefreshErrorBanner
        error={{ kind: "unsupported", failures: 1, at: 0 }}
        fetchedAtClientMs={0}
        onRetry={jest.fn()}
        refreshing={false}
      />
    )
    expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument()
  })
})
