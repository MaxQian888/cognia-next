/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/stores/chat", () => ({
  useSessionMessages: () => [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Chat stopped" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "Sidecar is not ready" }] },
  ],
}))
jest.mock("./support-agent-controls", () => ({
  SupportAgentControls: () => <div data-testid="support-controls" />,
}))
jest.mock("./support-feedback-dialog", () => ({
  SupportFeedbackDialog: ({ initialSummary }: { initialSummary?: string }) => (
    <div data-testid="support-feedback">{initialSummary}</div>
  ),
}))
const trackEvent = jest.fn(async () => true)
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}))

import { render, screen } from "@testing-library/react"
import { SupportAgentPanel } from "./support-agent-panel"

it("bridges the live Support conversation into a user-confirmed feedback draft", () => {
  render(<SupportAgentPanel sessionId="support-session" />)
  expect(screen.getByTestId("support-agent-panel")).toBeInTheDocument()
  expect(screen.getByTestId("support-controls")).toBeInTheDocument()
  expect(screen.getByTestId("support-feedback")).toHaveTextContent("Chat stopped")
  expect(screen.getByTestId("support-feedback")).toHaveTextContent("Sidecar is not ready")
  expect(trackEvent).toHaveBeenCalledWith("support.session.opened", {
    sessionId: "support-session",
  })
  expect(screen.getByRole("link", { name: "openIssue" })).toHaveAttribute(
    "href",
    "https://github.com/MaxQian888/cognia-next/issues/new"
  )
})
