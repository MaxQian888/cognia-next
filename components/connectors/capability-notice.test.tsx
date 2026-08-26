/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import { capabilityAvailability } from "@/lib/connectors/capability-availability"
import { effectiveCapabilities } from "@/lib/connectors/effective-capabilities"

import { CapabilityNotice } from "./capability-notice"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values && Object.keys(values).length > 0 ? `${key}:${JSON.stringify(values)}` : key,
}))

function unavailable(
  snapshotInput: Parameters<typeof effectiveCapabilities>[0],
  capability: string
) {
  const result = capabilityAvailability(effectiveCapabilities(snapshotInput), capability as never)
  if (result.available) throw new Error(`${capability} is available in this fixture`)
  return result
}

it("states the reason and the next step for a fixable cause", () => {
  render(
    <CapabilityNotice
      availability={unavailable(
        { platform: "slack", settings: { connectedScopes: { scopes: ["chat:write"] } } },
        "history.fetch"
      )}
    />
  )
  const notice = screen.getByTestId("capability-notice")
  expect(notice).toHaveAttribute("data-cause", "missing_oauth_scope")
  expect(notice).toHaveTextContent("reason.missing_oauth_scope")
  expect(notice).toHaveTextContent("nextStep.missing_oauth_scope")
})

/**
 * Two of the six causes have nothing to do about them. Inventing a remedy for
 * a platform limit is worse than silence — it sends someone to re-check
 * settings that are already right.
 */
it("offers no next step for a platform that never had the capability", () => {
  render(<CapabilityNotice availability={unavailable({ platform: "wecom" }, "send.reply")} />)
  const notice = screen.getByTestId("capability-notice")
  expect(notice).toHaveAttribute("data-cause", "not_declared")
  expect(notice).toHaveTextContent("reason.not_declared")
  expect(notice).not.toHaveTextContent("nextStep")
})

it("offers no next step for a scene limit either", () => {
  render(
    <CapabilityNotice
      availability={unavailable({ platform: "qq-official", scopeKind: "private" }, "send.reaction")}
    />
  )
  expect(screen.getByTestId("capability-notice")).not.toHaveTextContent("nextStep")
})

// Scope names and setting keys are matched against the platform's own console,
// so they are passed through verbatim rather than translated.
it("passes the machine-readable detail through to the message", () => {
  render(
    <CapabilityNotice
      availability={unavailable(
        { platform: "slack", settings: { connectedScopes: { scopes: ["chat:write"] } } },
        "send.file"
      )}
    />
  )
  expect(screen.getByTestId("capability-notice")).toHaveTextContent("files:write")
})

it("renders a caller-supplied remedy button after the text", () => {
  render(
    <CapabilityNotice
      availability={unavailable({ platform: "wecom" }, "send.reply")}
      action={<button type="button">fix it</button>}
    />
  )
  expect(screen.getByRole("button", { name: "fix it" })).toBeInTheDocument()
})
