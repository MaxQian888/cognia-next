/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import messages from "@/i18n/messages/en/externalAgent.json"
import { AgentDetailStatus } from "./agent-detail-status"

// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={{ externalAgent: messages }} timeZone="UTC">
    {children}
  </NextIntlClientProvider>
)

describe("AgentDetailStatus", () => {
  it.each(["ok", "info", "warning", "error"] as const)("announces the %s tone once", (tone) => {
    render(<AgentDetailStatus tone={tone} title="Agent state" message="State explanation" />, {
      wrapper,
    })
    expect(
      screen.getByRole(tone === "error" ? "alert" : "status", { name: "Agent state" })
    ).toHaveTextContent("State explanation")
    expect(screen.queryByRole(tone === "error" ? "status" : "alert")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-detail-status")).not.toHaveClass("border")
  })

  it("renders one full-width primary action and an optional secondary text action", () => {
    const onRun = jest.fn()
    const onSecondary = jest.fn()
    render(
      <AgentDetailStatus
        tone="info"
        title="Offline"
        action={{ label: "Connect", onRun }}
        secondary={{ label: "Dismiss", onRun: onSecondary }}
      />,
      { wrapper }
    )
    const connect = screen.getByRole("button", { name: "Connect" })
    expect(connect).toHaveClass("min-h-11", "w-full")
    fireEvent.click(connect)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onSecondary).toHaveBeenCalledTimes(1)
  })

  it("disables a busy action and describes why an action is disabled", () => {
    const onRun = jest.fn()
    render(
      <AgentDetailStatus
        tone="warning"
        title="Unavailable"
        action={{
          label: "Connect",
          onRun,
          busy: true,
          disabledReason: "Enable external agents first",
        }}
      />,
      { wrapper }
    )
    const button = screen.getByRole("button", { name: "Connect" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(button).toHaveAccessibleDescription("Enable external agents first")
    fireEvent.click(button)
    expect(onRun).not.toHaveBeenCalled()
  })

  it("supports a link action, but removes navigation when disabled", () => {
    const { rerender } = render(
      <AgentDetailStatus
        tone="info"
        title="Install runtime"
        action={{ label: "Open runtimes", href: "/settings/runtimes" }}
      />,
      { wrapper }
    )
    expect(screen.getByRole("link", { name: "Open runtimes" })).toHaveAttribute(
      "href",
      "/settings/runtimes"
    )
    rerender(
      <AgentDetailStatus
        tone="info"
        title="Install runtime"
        action={{ label: "Open runtimes", href: "/settings/runtimes", disabled: true }}
      />
    )
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Open runtimes" })).toBeDisabled()
  })

  it("runs plain link activations locally and preserves modified link navigation", () => {
    const onRun = jest.fn()
    render(
      <AgentDetailStatus
        tone="info"
        title="Plugin needed"
        action={{ label: "Open plugins", href: "#plugins", onRun }}
      />,
      { wrapper }
    )
    const link = screen.getByRole("link", { name: "Open plugins" })
    expect(fireEvent.click(link)).toBe(false)
    expect(onRun).toHaveBeenCalledTimes(1)
    for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      expect(fireEvent.click(link, { [modifier]: true })).toBe(true)
    }
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it("keeps details behind a disclosure, with a customizable readiness label", () => {
    const { rerender } = render(
      <AgentDetailStatus tone="info" title="Offline" details={<p>Transport cause</p>} />,
      { wrapper }
    )
    const disclosure = screen.getByText("Show details").closest("details")
    expect(disclosure).not.toHaveAttribute("open")
    fireEvent.click(screen.getByText("Show details"))
    expect(disclosure).toHaveAttribute("open")
    rerender(
      <AgentDetailStatus
        tone="info"
        title="Offline"
        details={<p>Readiness pipeline</p>}
        detailsLabel="Readiness steps"
      />
    )
    expect(screen.getByText("Readiness steps")).toBeInTheDocument()
  })

  it("places a consent action inside the status block and replaces the ordinary action", () => {
    render(
      <AgentDetailStatus
        tone="warning"
        title="Consent needed"
        action={{ label: "Unused" }}
        actionContent={<button>Review consent</button>}
      />,
      { wrapper }
    )
    expect(screen.getByRole("status")).toContainElement(
      screen.getByRole("button", { name: "Review consent" })
    )
    expect(screen.queryByRole("button", { name: "Unused" })).not.toBeInTheDocument()
  })
})
