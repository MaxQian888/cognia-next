/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { CapabilityMatrixCard } from "./capability-matrix-card"

function row(patch: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow {
  return {
    id: "a1",
    type: "slack",
    settings: {},
    ...patch,
  } as unknown as AdapterInstanceRow
}

describe("CapabilityMatrixCard", () => {
  it("renders nothing for a platform that declares no capabilities", () => {
    const { container } = render(<CapabilityMatrixCard row={row({ type: "email" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists what the bot can do", () => {
    render(<CapabilityMatrixCard row={row({ type: "telegram" })} />)
    expect(screen.getByTestId("capability-matrix-card")).toBeInTheDocument()
    expect(screen.getByText("send.text")).toBeInTheDocument()
  })

  it("omits the unavailable section when nothing is suppressed", () => {
    render(<CapabilityMatrixCard row={row({ type: "telegram" })} />)
    expect(screen.queryByTestId("capability-matrix-unavailable")).toBeNull()
  })

  it("names a missing OAuth scope and the scopes that would satisfy it", () => {
    // This is the whole point of the card: a Slack grant without `files:write`
    // silently stopped offering uploads, and nothing told the operator that
    // re-authorizing would bring them back.
    render(
      <CapabilityMatrixCard
        row={row({
          settings: { connectedScopes: { scopes: ["chat:write"], grantedAtMs: 1 } },
        })}
      />
    )
    const unavailable = screen.getByTestId("capability-matrix-unavailable")
    expect(unavailable).toHaveTextContent("send.file")
    expect(unavailable).toHaveTextContent("reason.missing_oauth_scope")
    expect(unavailable).toHaveTextContent("files:write")
  })

  it("keeps a capability the grant does cover out of the unavailable list", () => {
    render(
      <CapabilityMatrixCard
        row={row({
          settings: { connectedScopes: { scopes: ["chat:write"], grantedAtMs: 1 } },
        })}
      />
    )
    expect(screen.getByTestId("capability-matrix-available")).toHaveTextContent("send.text")
    expect(screen.getByTestId("capability-matrix-unavailable")).not.toHaveTextContent("send.text")
  })

  it("names the setting that turned a capability off", () => {
    render(<CapabilityMatrixCard row={row({ type: "slack" })} />)
    const unavailable = screen.getByTestId("capability-matrix-unavailable")
    expect(unavailable).toHaveTextContent("reason.instance_setting_off")
    expect(unavailable).toHaveTextContent("assistantAppEnabled")
  })

  it("names the transport a capability needs", () => {
    render(<CapabilityMatrixCard row={row({ type: "discord", transportMode: "webhook" })} />)
    const unavailable = screen.getByTestId("capability-matrix-unavailable")
    expect(unavailable).toHaveTextContent("presence.status")
    expect(unavailable).toHaveTextContent("reason.transport_unsupported")
  })

  it("names the upstream action a OneBot server does not implement", () => {
    render(
      <CapabilityMatrixCard
        row={row({
          type: "onebot",
          implMetadata: { impl: "lagrange", version: "0", features: [] },
        })}
      />
    )
    const unavailable = screen.getByTestId("capability-matrix-unavailable")
    expect(unavailable).toHaveTextContent("reason.upstream_impl_unsupported")
    expect(unavailable).toHaveTextContent("set_msg_emoji_like")
  })

  it("leaves only the deliberately-unmapped capability on a grant that covers nothing", () => {
    // `app_mentions:read` satisfies no rule, so every mapped capability is
    // suppressed. `presence.status` survives because its bot-token scope is
    // unverified and the resolver refuses to guess one — see the rule table.
    render(
      <CapabilityMatrixCard
        row={row({
          settings: { connectedScopes: { scopes: ["app_mentions:read"], grantedAtMs: 1 } },
        })}
      />
    )
    expect(screen.getByTestId("capability-matrix-available")).toHaveTextContent("presence.status")
    expect(screen.getByTestId("capability-matrix-unavailable")).toHaveTextContent("send.text")
  })

  it("renders a platform whose whole declared set is unconditional", () => {
    // WeChat OA declares `send.text` + `typing`, neither of which any rule
    // touches — the card must still render rather than treating "nothing
    // suppressed" as "nothing to show".
    render(<CapabilityMatrixCard row={row({ type: "wechat-oa" })} />)
    expect(screen.getByTestId("capability-matrix-available")).toHaveTextContent("send.text")
    expect(screen.queryByTestId("capability-matrix-unavailable")).toBeNull()
  })

  /**
   * A narrow Slack grant suppresses five capabilities for the same missing
   * scope. Every row still names its own capability and reason; five stacked
   * copies of the remedy read as five separate problems.
   */
  it("prints the remedy once per cause, not once per capability", () => {
    render(
      <CapabilityMatrixCard
        row={row({
          type: "slack",
          settings: { connectedScopes: { scopes: ["chat:write"], grantedAtMs: 1 } },
        })}
      />
    )
    const text = screen.getByTestId("capability-matrix-unavailable").textContent ?? ""
    const remedies = text.split("nextStep.missing_oauth_scope").length - 1
    const reasons = text.split("reason.missing_oauth_scope").length - 1
    expect(reasons).toBeGreaterThan(1)
    expect(remedies).toBe(1)
  })
})
