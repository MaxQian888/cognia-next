/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { PairPayload } from "@/lib/qr/pair-payload"

import { InvitationCard, displayPairHost } from "./invitation-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars?.version ? `${key}(v${String(vars.version)})` : key,
}))

const invitation: PairPayload = {
  baseUrl: "http://127.0.0.1:27891",
  mode: "owner-invitation",
  invitation: "invite",
  hostId: "host-1",
  tenantId: "tenant-1",
  expiresAt: Date.now() + 60_000,
  serverVersion: "0.1.0",
  fingerprint: "ab".repeat(32),
}

it("leads with the target, not the blob", () => {
  render(
    <InvitationCard invitation={invitation}>
      <textarea data-testid="raw-field" defaultValue="cgnp3|xxx" />
    </InvitationCard>
  )
  expect(screen.getByTestId("pair-invitation-host")).toHaveTextContent("127.0.0.1:27891")
  expect(screen.getByTestId("pair-invitation-card")).toHaveTextContent("v0.1.0")
})

it("keeps the raw field mounted while the disclosure is closed", async () => {
  // It is the form's controlled input; a control that leaves the tree when a
  // chevron closes is a control whose value the form no longer owns.
  render(
    <InvitationCard invitation={invitation}>
      <textarea data-testid="raw-field" defaultValue="cgnp3|xxx" />
    </InvitationCard>
  )
  const field = screen.getByTestId("raw-field")
  expect(field).toHaveValue("cgnp3|xxx")
  expect(screen.getByTestId("pair-invitation-raw")).not.toBeVisible()

  await userEvent.click(screen.getByTestId("pair-invitation-raw-toggle"))
  expect(screen.getByTestId("pair-invitation-raw")).toBeVisible()
})

it("owns the one statement about what happened to this invitation", () => {
  const { rerender } = render(<InvitationCard invitation={invitation} />)
  expect(screen.getByTestId("pair-invitation-card")).toHaveAttribute("data-tone", "ready")
  expect(screen.getByTestId("pair-invitation-card")).toHaveTextContent("state.ready")

  rerender(<InvitationCard invitation={invitation} tone="spent" />)
  expect(screen.getByTestId("pair-invitation-card")).toHaveAttribute("data-tone", "spent")
  expect(screen.getByTestId("pair-invitation-card")).not.toHaveTextContent("state.ready")

  rerender(<InvitationCard invitation={invitation} tone="failed" />)
  expect(screen.getByTestId("pair-invitation-card")).toHaveAttribute("data-tone", "failed")
})

it("offers the replace action only when the caller can honour it", async () => {
  const onClear = jest.fn()
  const { rerender } = render(<InvitationCard invitation={invitation} />)
  expect(screen.queryByTestId("pair-clear-payload")).not.toBeInTheDocument()

  rerender(<InvitationCard invitation={invitation} onClear={onClear} />)
  await userEvent.click(screen.getByTestId("pair-clear-payload"))
  expect(onClear).toHaveBeenCalled()
})

it("falls back to the raw base URL when it is not parseable", () => {
  expect(displayPairHost("http://host.local:27890")).toBe("host.local:27890")
  expect(displayPairHost("not a url")).toBe("not a url")
})
