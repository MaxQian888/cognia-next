/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"

const mockRequireBiometric = jest.fn()
jest.mock("@/lib/biometric/prompt", () => ({
  requireBiometric: (...args: unknown[]) => mockRequireBiometric(...args),
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    message: jest.fn(),
  },
}))

import { ComputerUseToggle } from "./computer-use-toggle"
import { __setInboxWriteRouteDepsForTests } from "@/lib/connectors/inbox-writes/route"

function wrap(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as unknown as Record<string, unknown>}>
      <TooltipProvider>{ui}</TooltipProvider>
    </NextIntlClientProvider>
  )
}

// This suite drives real fake-indexeddb transactions and runs inside a
// CPU-starved parallel worker during full-suite runs — the library default
// 1s waitFor window timed out purely on wall-clock starvation. Give the
// whole file generous budgets; the assertions themselves are unchanged.
jest.setTimeout(20000)
const WAIT = { timeout: 10000 } as const

// ADR-0131: keep the REAL mutation path so the Dexie + audit assertions below
// still mean something — only pin the ROUTE, as a connector host would.
let restoreRoute: () => void = () => undefined
afterEach(() => restoreRoute())

beforeEach(async () => {
  restoreRoute = __setInboxWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    hasConnectorRuntime: () => true,
  })
  await getDb().delete()
  __resetDbForTesting()
  mockRequireBiometric.mockReset()
})

describe("ComputerUseToggle", () => {
  it("renders OFF state when currentValue is false", () => {
    wrap(
      <ComputerUseToggle
        conversationKey="lark:lark-1:oc_off"
        sessionId="s1"
        adapterId="lark-1"
        currentValue={false}
      />
    )
    const button = screen.getByTestId("computer-use-toggle")
    expect(button).toHaveAttribute("aria-pressed", "false")
  })

  it("turns on after biometric confirms, persists row, writes audit", async () => {
    mockRequireBiometric.mockResolvedValueOnce({
      ok: true,
      bioVerified: false,
      via: "browser-confirm",
    })
    wrap(
      <ComputerUseToggle
        conversationKey="lark:lark-1:oc_on"
        sessionId="s2"
        adapterId="lark-1"
        currentValue={false}
      />
    )
    fireEvent.click(screen.getByTestId("computer-use-toggle"))
    await waitFor(async () => {
      const row = await getDb()
        .conversationOverrides.where("conversationKey")
        .equals("lark:lark-1:oc_on")
        .first()
      expect(row?.allowComputerUse).toBe(true)
    }, WAIT)
    // The audit append is a separate transaction after the override upsert, so
    // it must be awaited independently (immediate read was load-flaky).
    await waitFor(async () => {
      const audit = await getDb().connectorAudit.toArray()
      expect(audit.some((a) => a.kind === "override.computer_use_changed")).toBe(true)
    }, WAIT)
  })

  it("does NOT enable when biometric is rejected", async () => {
    mockRequireBiometric.mockResolvedValueOnce({
      ok: false,
      bioVerified: false,
      via: "browser-confirm",
    })
    wrap(
      <ComputerUseToggle
        conversationKey="lark:lark-1:oc_no"
        sessionId="s3"
        adapterId="lark-1"
        currentValue={false}
      />
    )
    fireEvent.click(screen.getByTestId("computer-use-toggle"))
    await new Promise((r) => setTimeout(r, 0))
    const row = await getDb()
      .conversationOverrides.where("conversationKey")
      .equals("lark:lark-1:oc_no")
      .first()
    expect(row?.allowComputerUse).toBeUndefined()
  })

  it("turns off without biometric and writes audit", async () => {
    wrap(
      <ComputerUseToggle
        conversationKey="lark:lark-1:oc_disable"
        sessionId="s4"
        adapterId="lark-1"
        currentValue={true}
      />
    )
    fireEvent.click(screen.getByTestId("computer-use-toggle"))
    await waitFor(async () => {
      const audit = await getDb().connectorAudit.toArray()
      expect(audit.some((a) => a.kind === "override.computer_use_changed")).toBe(true)
    }, WAIT)
    expect(mockRequireBiometric).not.toHaveBeenCalled()
  })
})
