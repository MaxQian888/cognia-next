/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import en from "@/i18n/messages/en.json"
import type { ExternalAgentConnectionStatus } from "@/types/agent/external-agent"

import { ConnectionStatusBadge } from "./connection-status-badge"

const labels = en.externalAgent as unknown as Record<string, string>

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    {ui}
  </NextIntlClientProvider>
)

describe("ConnectionStatusBadge", () => {
  const cases: Array<{ status: ExternalAgentConnectionStatus; labelKey: string }> = [
    { status: "disconnected", labelKey: "statusDisconnected" },
    { status: "connecting", labelKey: "statusConnecting" },
    { status: "connected", labelKey: "statusConnected" },
    { status: "reconnecting", labelKey: "statusReconnecting" },
    { status: "error", labelKey: "statusError" },
  ]

  it.each(cases)("renders the translated label for $status", ({ status, labelKey }) => {
    render(wrap(<ConnectionStatusBadge status={status} />))
    expect(screen.getByText(labels[labelKey])).toBeInTheDocument()
  })

  it("omits icons by default", () => {
    const { container } = render(wrap(<ConnectionStatusBadge status="connected" />))
    expect(container.querySelector("svg")).toBeNull()
  })

  it("renders a leading icon for connected when withIcon is set", () => {
    const { container } = render(wrap(<ConnectionStatusBadge status="connected" withIcon />))
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("renders a leading icon for error when withIcon is set", () => {
    const { container } = render(wrap(<ConnectionStatusBadge status="error" withIcon />))
    expect(container.querySelector("svg")).not.toBeNull()
  })

  it("does not render an icon for non-connected/error states even with withIcon", () => {
    const { container } = render(wrap(<ConnectionStatusBadge status="connecting" withIcon />))
    expect(container.querySelector("svg")).toBeNull()
  })

  it("merges a custom className onto the badge", () => {
    render(wrap(<ConnectionStatusBadge status="connected" className="text-[10px] h-4 px-1.5" />))
    expect(screen.getByText(labels.statusConnected)).toHaveClass("h-4", "px-1.5")
  })
})
