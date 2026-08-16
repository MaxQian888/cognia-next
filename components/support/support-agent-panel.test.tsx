/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/stores/chat", () => ({
  useSessionMessages: () => [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Chat stopped" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Sidecar is not ready" }] },
  ],
}))
jest.mock("./support-diagnostics-consent", () => ({
  SupportDiagnosticsConsent: ({ surface }: { surface: string }) => (
    <div data-testid="support-consent" data-surface={surface} />
  ),
}))
jest.mock("./report-problem-dialog", () => ({
  ReportProblemDialog: ({
    context,
    trigger,
  }: {
    context: { surface: string; sessionId?: string; conversationSummary?: string }
    trigger: React.ReactNode
  }) => (
    <div
      data-testid="report-dialog"
      data-surface={context.surface}
      data-session={context.sessionId}
      data-summary={context.conversationSummary}
    >
      {trigger}
    </div>
  ),
}))
const trackEvent = jest.fn(async (..._args: unknown[]) => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { SUPPORT_DIAGNOSTICS_STORAGE_KEY } from "@/lib/support-agent/context"

import { SupportAgentPanel } from "./support-agent-panel"

beforeEach(() => {
  localStorage.clear()
  trackEvent.mockClear()
})

it("hands the live Support conversation to the report dialog as a redacted section", () => {
  render(<SupportAgentPanel sessionId="support-session" />)
  expect(screen.getByTestId("support-agent-panel")).toBeInTheDocument()
  const dialog = screen.getByTestId("report-dialog")
  expect(dialog).toHaveAttribute("data-surface", "chat")
  expect(dialog).toHaveAttribute("data-session", "support-session")
  expect(dialog.getAttribute("data-summary")).toContain("userReport:\nChat stopped")
  expect(dialog.getAttribute("data-summary")).toContain("supportResponse:\nSidecar is not ready")
  expect(screen.getByRole("button", { name: "reportProblem" })).toBeInTheDocument()
  expect(trackEvent).toHaveBeenCalledWith("support.session.opened", {
    sessionId: "support-session",
  })
})

it("reflects the shared consent state on the chip and exposes the control in a popover", async () => {
  const user = userEvent.setup()
  render(<SupportAgentPanel sessionId={null} />)
  const chip = screen.getByTestId("support-diagnostics-chip")
  expect(chip).toHaveTextContent("diagnosticsOff")
  expect(trackEvent).not.toHaveBeenCalledWith("support.session.opened", expect.anything())

  await user.click(chip)
  expect(await screen.findByTestId("support-consent")).toHaveAttribute("data-surface", "chat")
})

it("shows the chip as on when consent was already granted", () => {
  localStorage.setItem(SUPPORT_DIAGNOSTICS_STORAGE_KEY, "true")
  render(<SupportAgentPanel sessionId={null} />)
  expect(screen.getByTestId("support-diagnostics-chip")).toHaveTextContent("diagnosticsOn")
})
