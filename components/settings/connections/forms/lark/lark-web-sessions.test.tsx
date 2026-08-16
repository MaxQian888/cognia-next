/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
    t.has = () => true
    return t
  },
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { touchWebSession, revokeWebSession } from "@/lib/db/lark-entry"
import { LarkWebSessions, larkSessionState } from "./lark-web-sessions"

const ADAPTER_ID = "lark-sessions-1"
const NOW = 1_800_000_000_000
const HOUR = 3_600_000

async function seed(
  jtiHash: string,
  overrides: Partial<{
    adapterId: string
    expiresAt: number
    lastSeenAt: number
    openIdHash: string
  }> = {}
) {
  await touchWebSession({
    jtiHash,
    adapterId: overrides.adapterId ?? ADAPTER_ID,
    openIdHash: overrides.openIdHash ?? `hash_${jtiHash}`,
    tenantKey: "tk_a",
    appId: "cli_1",
    issuedAt: Date.now() - HOUR,
    expiresAt: overrides.expiresAt ?? Date.now() + HOUR,
    now: overrides.lastSeenAt ?? Date.now(),
  })
}

describe("larkSessionState", () => {
  const base = {
    id: "ws_1",
    adapterId: ADAPTER_ID,
    openIdHash: "hash",
    tenantKey: "tk_a",
    appId: "cli_1",
    issuedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    lastSeenAt: NOW,
  }

  it("reads live, expired and revoked off the row", () => {
    expect(larkSessionState(base, NOW)).toBe("live")
    expect(larkSessionState({ ...base, expiresAt: NOW - 1 }, NOW)).toBe("expired")
    // Revoked wins over a still-valid TTL: the principal behind it is gone.
    expect(larkSessionState({ ...base, revokedAt: NOW - 1 }, NOW)).toBe("revoked")
    expect(larkSessionState({ ...base, expiresAt: NOW - 1, revokedAt: NOW - 1 }, NOW)).toBe(
      "revoked"
    )
  })

  it("treats the expiry instant itself as expired", () => {
    expect(larkSessionState({ ...base, expiresAt: NOW }, NOW)).toBe("expired")
  })
})

describe("LarkWebSessions", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("shows the empty state when no session has ever been seen", async () => {
    render(<LarkWebSessions adapterId={ADAPTER_ID} />)
    await waitFor(() => expect(screen.getByTestId("lark-web-sessions-empty")).toBeInTheDocument())
    expect(screen.queryByTestId("lark-web-sessions-summary")).not.toBeInTheDocument()
  })

  it("lists this adapter's sessions newest-first with their state", async () => {
    await seed("ws_old", { lastSeenAt: Date.now() - 10_000 })
    await seed("ws_new")
    await seed("ws_gone", { expiresAt: Date.now() - 1 })
    await seed("ws_elsewhere", { adapterId: "lark-other" })

    render(<LarkWebSessions adapterId={ADAPTER_ID} />)
    await waitFor(() => expect(screen.getByTestId("lark-web-session-ws_new")).toBeInTheDocument())

    const ids = screen
      .getAllByTestId(/^lark-web-session-/)
      .map((node) => node.getAttribute("data-testid"))
    expect(ids).toEqual([
      "lark-web-session-ws_gone",
      "lark-web-session-ws_new",
      "lark-web-session-ws_old",
    ])
    // Another adapter's sessions are not this adapter's business.
    expect(screen.queryByTestId("lark-web-session-ws_elsewhere")).not.toBeInTheDocument()
    expect(screen.getByTestId("lark-web-sessions-summary").textContent).toContain(
      '{"live":2,"total":3}'
    )
    expect(screen.getByTestId("lark-web-session-ws_gone").textContent).toContain("state.expired")
  })

  it("reports a revoked session rather than hiding it", async () => {
    await seed("ws_revoked")
    await revokeWebSession("ws_revoked")
    render(<LarkWebSessions adapterId={ADAPTER_ID} />)
    await waitFor(() =>
      expect(screen.getByTestId("lark-web-session-ws_revoked").textContent).toContain(
        "state.revoked"
      )
    )
    expect(screen.getByTestId("lark-web-sessions-summary").textContent).toContain(
      '{"live":0,"total":1}'
    )
  })

  it("prunes rows past the retention window and reports the count", async () => {
    const day = 24 * HOUR
    await seed("ws_ancient", { expiresAt: Date.now() - 40 * day })
    await seed("ws_recent", { expiresAt: Date.now() - day })

    render(<LarkWebSessions adapterId={ADAPTER_ID} />)
    await waitFor(() =>
      expect(screen.getByTestId("lark-web-session-ws_ancient")).toBeInTheDocument()
    )
    await userEvent.click(screen.getByTestId("lark-web-sessions-prune"))

    await waitFor(() =>
      expect(screen.getByText('pruned:{"count":1}', { exact: false })).toBeInTheDocument()
    )
    // A just-expired session survives — it is the one an incident needs.
    expect(screen.getByTestId("lark-web-session-ws_recent")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId("lark-web-session-ws_ancient")).not.toBeInTheDocument()
    )
  })

  it("surfaces a prune failure instead of leaving the button silently dead", async () => {
    await seed("ws_1")
    render(<LarkWebSessions adapterId={ADAPTER_ID} />)
    await waitFor(() => expect(screen.getByTestId("lark-web-session-ws_1")).toBeInTheDocument())

    const table = getDb().larkWebSessions
    const spy = jest.spyOn(table, "where").mockImplementation(() => {
      throw new Error("dexie is closed")
    })
    try {
      await userEvent.click(screen.getByTestId("lark-web-sessions-prune"))
      await waitFor(() =>
        expect(screen.getByTestId("lark-web-sessions-error").textContent).toContain(
          "dexie is closed"
        )
      )
    } finally {
      spy.mockRestore()
    }
  })

  it("renders a non-Error rejection instead of [object Object]", async () => {
    await seed("ws_1")
    render(<LarkWebSessions adapterId={ADAPTER_ID} />)
    await waitFor(() => expect(screen.getByTestId("lark-web-session-ws_1")).toBeInTheDocument())

    // Dexie rejects with plain values in some paths; the card must still say
    // something an operator can act on.
    const spy = jest.spyOn(getDb().larkWebSessions, "where").mockImplementation(() => {
      throw "DatabaseClosedError"
    })
    try {
      await userEvent.click(screen.getByTestId("lark-web-sessions-prune"))
      await waitFor(() =>
        expect(screen.getByTestId("lark-web-sessions-error").textContent).toContain(
          "DatabaseClosedError"
        )
      )
    } finally {
      spy.mockRestore()
    }
  })
})
