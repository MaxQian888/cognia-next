import { render, screen } from "@testing-library/react"

import { BindTimeBadge } from "./bind-time-badge"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

describe("BindTimeBadge", () => {
  it("marks a bind-time field before anything has been edited", () => {
    render(<BindTimeBadge field="port" pending={[]} />)

    const badge = screen.getByTestId("gateway-bind-time-port")
    expect(badge).toHaveTextContent("bindTimeBadge")
    expect(badge).toHaveAttribute("data-pending", "false")
  })

  it("switches to the pending state when Rust reports the field as diverged", () => {
    render(<BindTimeBadge field="allowlist" pending={["port", "allowlist"]} />)

    const badge = screen.getByTestId("gateway-bind-time-allowlist")
    expect(badge).toHaveTextContent("restartPendingBadge")
    expect(badge).toHaveAttribute("data-pending", "true")
  })

  it("ignores pending fields other than its own", () => {
    render(<BindTimeBadge field="connectTimeoutSecs" pending={["port"]} />)

    expect(screen.getByTestId("gateway-bind-time-connectTimeoutSecs")).toHaveTextContent(
      "bindTimeBadge"
    )
  })
})
