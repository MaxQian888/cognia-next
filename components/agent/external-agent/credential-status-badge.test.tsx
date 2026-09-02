/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TooltipProvider } from "@/components/ui/tooltip"
import en from "@/i18n/messages/en.json"
import type { PiAuthVerdict } from "@/lib/ai/agent/external/pi-auth"

let authStatus = {
  status: { listing: "ok" as "ok" | "unreadable" | "idle", verdicts: [] as PiAuthVerdict[] },
  loading: false,
  available: true,
  refresh: async () => {},
}
let connected = true

jest.mock("@/hooks/agent/use-pi-auth-status", () => ({
  usePiAuthStatus: () => authStatus,
}))
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ connectionStatus: { "pi-1": connected ? "connected" : "disconnected" } }),
}))

import { AgentCredentialBadge, resolveCredentialState } from "./credential-status-badge"

const labels = (en.externalAgent as unknown as { credential: Record<string, string> }).credential

const wrap = (ui: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
    <TooltipProvider>{ui}</TooltipProvider>
  </NextIntlClientProvider>
)

function verdict(status: PiAuthVerdict["status"], provider: string): PiAuthVerdict {
  return { status, provider } as PiAuthVerdict
}

describe("resolveCredentialState", () => {
  it("separates an unreadable probe from an unauthenticated agent", () => {
    // Pi exits 1 both for "no credentials" and for "Cognia called the CLI
    // wrong". Collapsing them tells a user to fix credentials that are fine.
    expect(
      resolveCredentialState({ loading: false, listing: "unreadable", ready: 0, total: 0 })
    ).toBe("unreadable")
    expect(resolveCredentialState({ loading: false, listing: "ok", ready: 0, total: 2 })).toBe(
      "none"
    )
  })

  it("treats an empty provider list as the headline, not as nothing to say", () => {
    expect(resolveCredentialState({ loading: false, listing: "ok", ready: 0, total: 0 })).toBe(
      "none"
    )
  })

  it("keeps partial as its own state", () => {
    expect(resolveCredentialState({ loading: false, listing: "ok", ready: 1, total: 3 })).toBe(
      "partial"
    )
    expect(resolveCredentialState({ loading: false, listing: "ok", ready: 3, total: 3 })).toBe(
      "ready"
    )
  })

  it("says nothing at all before the probe has run", () => {
    expect(
      resolveCredentialState({ loading: false, listing: "idle", ready: 0, total: 0 })
    ).toBeNull()
    expect(resolveCredentialState({ loading: true, listing: "idle", ready: 0, total: 0 })).toBe(
      "checking"
    )
  })
})

describe("AgentCredentialBadge", () => {
  beforeEach(() => {
    connected = true
    authStatus = {
      status: { listing: "ok", verdicts: [verdict("ready", "anthropic")] },
      loading: false,
      available: true,
      refresh: async () => {},
    }
  })

  it("renders the signed-in state for a fully authenticated agent", () => {
    render(wrap(<AgentCredentialBadge agentId="pi-1" />))
    expect(screen.getByText(labels.ready)).toBeInTheDocument()
  })

  it("counts the signed-in providers when only some are", () => {
    authStatus.status.verdicts = [verdict("ready", "anthropic"), verdict("not_ready", "openai")]
    render(wrap(<AgentCredentialBadge agentId="pi-1" />))
    expect(screen.getByText("1/2 signed in")).toBeInTheDocument()
  })

  it("renders nothing for an agent with no credential probe", () => {
    // Every agent except Pi today. An absent badge means "not asked", and must
    // never be mistaken for "fine".
    authStatus.available = false
    const { container } = render(wrap(<AgentCredentialBadge agentId="pi-1" />))
    expect(container).toBeEmptyDOMElement()
  })

  it("says the state is unknown rather than bad when the probe is unreadable", () => {
    authStatus.status = { listing: "unreadable", verdicts: [] }
    render(wrap(<AgentCredentialBadge agentId="pi-1" />))
    expect(screen.getByText(labels.unreadable)).toBeInTheDocument()
  })
})
