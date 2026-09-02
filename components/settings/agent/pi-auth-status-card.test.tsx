import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import enMessages from "@/i18n/messages/en/externalAgent.json"
import zhMessages from "@/i18n/messages/zh-CN/externalAgent.json"
import type { PiAuthStatus } from "@/hooks/agent/use-pi-auth-status"
import type { PiAuthType, PiAuthProbeStatus } from "@/lib/ai/agent/external/pi-auth"

import { PiAuthStatusCard } from "./pi-auth-status-card"

let hookValue: {
  status: PiAuthStatus
  loading: boolean
  available: boolean
  refresh: () => Promise<void>
}

jest.mock("@/hooks/agent/use-pi-auth-status", () => ({
  usePiAuthStatus: () => hookValue,
}))

const runInTerminalDock = jest.fn<Promise<void>, [string, string, string]>()
let terminalReachable = true
jest.mock("@/lib/terminal/run-in-dock", () => ({
  runInTerminalDock: (...args: [string, string, string]) => runInTerminalDock(...args),
}))
jest.mock("@/lib/terminal/pick-transport", () => ({
  terminalAvailable: () => terminalReachable,
}))
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: (selector: (state: unknown) => unknown) =>
    selector({ agents: { "pi-1": { process: { command: "pi", cwd: "/work" } } } }),
}))
const toast = { message: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    message: (...a: unknown[]) => toast.message(...a),
    error: (...a: unknown[]) => toast.error(...a),
  },
}))

// The real catalogue, not a hand-written stand-in: `lint:i18n` cannot see the
// dynamic `status.${…}` / `authType.${…}` lookups this card makes, so rendering
// against the shipped file is what actually proves those keys exist.
const messages = { externalAgent: enMessages }

function renderCard(props?: { connected?: boolean }) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PiAuthStatusCard agentId="pi-1" connected={props?.connected ?? true} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  runInTerminalDock.mockReset().mockResolvedValue(undefined)
  terminalReachable = true
  toast.message.mockReset()
  toast.error.mockReset()
  hookValue = {
    status: { listing: "idle", verdicts: [], models: [] },
    loading: false,
    available: true,
    refresh: jest.fn().mockResolvedValue(undefined),
  }
})

describe("PiAuthStatusCard", () => {
  it("stays out of the way until the agent is connected", () => {
    hookValue.available = false
    renderCard({ connected: false })
    expect(screen.queryByTestId("pi-auth-status")).not.toBeInTheDocument()
    expect(screen.getByText(enMessages.settings.piAuth.notConnected)).toBeInTheDocument()
  })

  it("reports a provider Pi can authenticate, with its auth type", () => {
    hookValue.status = {
      listing: "ok",
      verdicts: [{ status: "ready", provider: "deepseek", authType: "api_key" }],
      models: [],
    }
    renderCard()
    expect(screen.getByText("deepseek")).toBeInTheDocument()
    expect(screen.getByText(enMessages.settings.piAuth.status.ready)).toBeInTheDocument()
    expect(screen.getByText(enMessages.settings.piAuth.authType.api_key)).toBeInTheDocument()
  })

  it("calls an empty provider list the diagnosis, not a blank card", () => {
    // Pi answered, and the answer is "nothing is usable". This is the failure
    // that used to only appear as a failed first prompt.
    hookValue.status = { listing: "ok", verdicts: [], models: [] }
    renderCard()
    expect(screen.getByTestId("pi-auth-no-providers")).toHaveTextContent(
      enMessages.settings.piAuth.noProviders
    )
    expect(screen.queryByTestId("pi-auth-listing-unreadable")).not.toBeInTheDocument()
  })

  it("does not present a failed listing as 'no credentials'", () => {
    // The same empty array, but Pi never answered. Rendering the line above
    // here would accuse the user's credentials of a Cognia-side failure.
    hookValue.status = { listing: "unreadable", verdicts: [], models: [] }
    renderCard()
    expect(screen.getByTestId("pi-auth-listing-unreadable")).toHaveTextContent(
      enMessages.settings.piAuth.listingUnreadable
    )
    expect(screen.queryByTestId("pi-auth-no-providers")).not.toBeInTheDocument()
  })

  it("distinguishes 'could not check' from 'not signed in'", () => {
    hookValue.status = {
      listing: "ok",
      verdicts: [
        { status: "unreadable", provider: "groq", unreadableReason: "no_output" },
        { status: "not_ready", provider: "openai", reason: "credentials_not_configured" },
      ],
      models: [],
    }
    renderCard()
    expect(screen.getByText(enMessages.settings.piAuth.status.unreadable)).toBeInTheDocument()
    expect(screen.getByText(enMessages.settings.piAuth.status.not_ready)).toBeInTheDocument()
    // Only the genuinely-unconfigured provider earns the "go configure Pi" hint.
    expect(screen.getByTestId("pi-auth-hint")).toBeInTheDocument()
  })

  it("withholds the configure hint when nothing is actually unconfigured", () => {
    hookValue.status = {
      listing: "ok",
      verdicts: [{ status: "unreadable", provider: "groq", unreadableReason: "not_json" }],
      models: [],
    }
    renderCard()
    expect(screen.queryByTestId("pi-auth-hint")).not.toBeInTheDocument()
  })

  it("labels a verdict Pi returned without a provider", () => {
    hookValue.status = {
      listing: "ok",
      verdicts: [{ status: "ready", provider: null }],
      models: [],
    }
    renderCard()
    expect(screen.getByText(enMessages.settings.piAuth.unknownProvider)).toBeInTheDocument()
  })

  it("re-checks on demand", async () => {
    hookValue.status = { listing: "ok", verdicts: [], models: [] }
    renderCard()
    await userEvent.click(screen.getByTestId("pi-auth-refresh"))
    expect(hookValue.refresh).toHaveBeenCalledTimes(1)
  })

  it("says plainly that Cognia never reads the credentials", () => {
    // ADR-0119's credential boundary is a promise to the user, so it is on
    // screen rather than only in the ADR.
    hookValue.status = { listing: "ok", verdicts: [], models: [] }
    renderCard()
    expect(screen.getByText(enMessages.settings.piAuth.readOnlyNote)).toBeInTheDocument()
  })
})

describe("piAuth catalogue coverage", () => {
  // `lint:i18n` cannot follow `t(`status.${verdict.status}`)`, so a missing
  // member would render the raw key. These two lists are the card's entire
  // dynamic surface; pin them against BOTH locales.
  const STATUSES: PiAuthProbeStatus[] = ["ready", "not_ready", "invalid", "unreadable"]
  const AUTH_TYPES: PiAuthType[] = ["api_key", "oauth"]

  it.each([
    ["en", enMessages],
    ["zh-CN", zhMessages],
  ])("covers every probe status and auth type in %s", (_locale, catalogue) => {
    const piAuth = catalogue.settings.piAuth
    expect(STATUSES.length).toBeGreaterThan(0)
    for (const status of STATUSES) {
      expect(typeof piAuth.status[status]).toBe("string")
      expect(piAuth.status[status]).not.toHaveLength(0)
    }
    for (const authType of AUTH_TYPES) {
      expect(typeof piAuth.authType[authType]).toBe("string")
      expect(piAuth.authType[authType]).not.toHaveLength(0)
    }
    // No extra members: an unused key here means the union moved and the card
    // is about to render a raw enum for the new one.
    expect(Object.keys(piAuth.status).sort()).toEqual([...STATUSES].sort())
    expect(Object.keys(piAuth.authType).sort()).toEqual([...AUTH_TYPES].sort())
  })

  it("opens Pi in the terminal for sign-in, and explains when no terminal is reachable", async () => {
    hookValue.status = { listing: "ok", verdicts: [], models: [] }
    const { unmount } = renderCard()
    await userEvent.click(screen.getByTestId("pi-auth-sign-in"))
    expect(runInTerminalDock).toHaveBeenCalledWith("pi", "/work", "")
    expect(toast.message).toHaveBeenCalledWith(enMessages.settings.piAuth.signInOpened)
    unmount()

    terminalReachable = false
    renderCard()
    expect(screen.getByTestId("pi-auth-sign-in")).toBeDisabled()
    expect(screen.getByText(enMessages.settings.piAuth.signInNeedsTerminal)).toBeInTheDocument()
  })

  it("reports a terminal that refused to open", async () => {
    runInTerminalDock.mockRejectedValueOnce(new Error("spawn denied"))
    renderCard()
    await userEvent.click(screen.getByTestId("pi-auth-sign-in"))
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("spawn denied"))
  })

  it("lists the model catalog grouped by provider, and marks a listing-backed verdict", async () => {
    hookValue.status = {
      listing: "ok",
      verdicts: [{ status: "ready", provider: "commandcode", evidence: "model_listing" }],
      models: [
        { provider: "commandcode", id: "claude-opus-5" },
        { provider: "commandcode", id: "claude-sonnet-5" },
        { provider: "deepseek", id: "deepseek-v4-pro" },
      ],
    }
    renderCard()
    expect(screen.getByTestId("pi-auth-evidence-listing")).toHaveTextContent(
      enMessages.settings.piAuth.evidenceListing
    )
    const toggle = screen.getByTestId("pi-auth-models-toggle")
    expect(toggle).toHaveTextContent("3 models across 2 providers")
    await userEvent.click(toggle)
    expect(screen.getByText("claude-opus-5, claude-sonnet-5")).toBeInTheDocument()
  })
})
