/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import messages from "@/i18n/messages/en/externalAgent.json"
import { AgentDetailHeader } from "./agent-detail-header"

// Resolve complete namespaces from split sources; aggregates are rebuilt by the orchestrator.
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <NextIntlClientProvider locale="en" messages={{ externalAgent: messages }} timeZone="UTC">
    {children}
  </NextIntlClientProvider>
)

describe("AgentDetailHeader", () => {
  it("shows a plain focusable name and one metadata line with the inspector labels", () => {
    render(
      <AgentDetailHeader
        name="Codex CLI"
        presetId="codex"
        protocol="acp"
        transport="stdio"
        stateIsolation="isolated"
        headingId="agent-codex"
      />,
      { wrapper }
    )
    expect(screen.getByRole("heading", { name: "Codex CLI" })).toHaveAttribute(
      "data-detail-heading",
      "agent-codex"
    )
    expect(screen.getByRole("heading")).toHaveAttribute("tabindex", "-1")
    expect(
      screen.getByText(
        `ACP · ${messages.settings.transportStdioLabel} · ${messages.instances.traits.isolated}`
      )
    ).toBeInTheDocument()
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  it("defaults local state to shared and omits it for a network transport", () => {
    const { rerender } = render(
      <AgentDetailHeader name="Agent" protocol="acp" transport="stdio" />,
      { wrapper }
    )
    expect(
      screen.getByText(
        `ACP · ${messages.settings.transportStdioLabel} · ${messages.instances.traits.shared}`
      )
    ).toBeInTheDocument()
    rerender(
      <AgentDetailHeader
        name="Agent"
        protocol="opencode"
        transport="http"
        stateIsolation="isolated"
      />
    )
    expect(
      screen.getByText(`OPENCODE · ${messages.settings.transportHttpLabel}`)
    ).toBeInTheDocument()
    expect(screen.queryByText(/Own state/)).not.toBeInTheDocument()
    rerender(<AgentDetailHeader name="Agent" protocol="custom" transport="websocket" />)
    expect(screen.getByText("CUSTOM · websocket")).toBeInTheDocument()
  })

  it("renders a source link and the supplied menu without adding a back button", () => {
    const onOpenSource = jest.fn()
    render(
      <AgentDetailHeader
        name="Copy"
        protocol="acp"
        transport="stdio"
        sourceName="Original"
        onOpenSource={onOpenSource}
        menu={<button>More options</button>}
      />,
      { wrapper }
    )
    fireEvent.click(screen.getByRole("button", { name: "Copy of Original" }))
    expect(onOpenSource).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole("button")).toHaveLength(2)
  })
})
