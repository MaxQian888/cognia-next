import { fireEvent, render, screen } from "@testing-library/react"

import { createStatusFixture } from "@/lib/status/fixtures"
import type { StatusRuntime } from "@/lib/status/public-status"

import { StatusFooter } from "./status-footer"

const primary: StatusRuntime = {
  mode: "primary",
  apiBase: "/api/status/v1",
  primaryPageUrl: "https://status.cognia.cn/status/",
  allowsConsentWrites: true,
}
const capabilities = createStatusFixture("operational").capabilities

describe("StatusFooter", () => {
  it("links the feeds when the service offers them and states what is monitored", () => {
    const onSubscribe = jest.fn()
    render(<StatusFooter runtime={primary} capabilities={capabilities} onSubscribe={onSubscribe} />)
    expect(screen.getByRole("link", { name: "Atom feed" })).toHaveAttribute(
      "href",
      "/api/status/v1/feed.atom"
    )
    expect(screen.getByRole("link", { name: "RSS feed" })).toHaveAttribute(
      "href",
      "/api/status/v1/feed.rss"
    )
    const boundaries = screen.getByTestId("status-boundaries")
    expect(boundaries).toHaveTextContent("official hosted Cognia relay")
    expect(boundaries).toHaveTextContent("does not describe self-hosted relays")
    expect(screen.getByText(/not a service-level agreement/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }))
    expect(onSubscribe).toHaveBeenCalled()
  })

  it("omits feeds when they are unavailable and links a validated mirror", () => {
    render(
      <StatusFooter
        runtime={primary}
        capabilities={{
          ...capabilities,
          feeds: false,
          mirrorUrl: "https://mirror.example/status/",
        }}
        onSubscribe={jest.fn()}
      />
    )
    expect(screen.queryByRole("link", { name: "Atom feed" })).toBeNull()
    expect(screen.getByRole("link", { name: "Read-only mirror" })).toHaveAttribute(
      "href",
      "https://mirror.example/status/"
    )
  })

  it("drops a mirror URL that is not HTTPS", () => {
    render(
      <StatusFooter
        runtime={primary}
        capabilities={{ ...capabilities, mirrorUrl: "javascript:alert(1)" }}
        onSubscribe={jest.fn()}
      />
    )
    expect(screen.queryByRole("link", { name: "Read-only mirror" })).toBeNull()
  })

  it("links back to the primary page from a mirror", () => {
    render(
      <StatusFooter
        runtime={{ ...primary, mode: "mirror", allowsConsentWrites: false }}
        capabilities={null}
        onSubscribe={jest.fn()}
      />
    )
    expect(screen.getByRole("link", { name: "Primary status page" })).toHaveAttribute(
      "href",
      "https://status.cognia.cn/status/"
    )
  })
})
