/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { HelpAndWelcome, parseTriggerLines } from "./help-and-welcome"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

const baseRow = (overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow => ({
  id: "ad-hw",
  type: "lark",
  displayName: "Lark",
  enabled: true,
  transportMode: "webhook",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
  trigger: { rules: [{ kind: "private-default" }], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe("parseTriggerLines", () => {
  it("trims, drops blanks, and splits on newlines", () => {
    expect(parseTriggerLines(" /help \n\n  帮助\n menu ")).toEqual(["/help", "帮助", "menu"])
  })
  it("returns an empty list for whitespace-only input", () => {
    expect(parseTriggerLines("  \n \n")).toEqual([])
  })
})

describe("HelpAndWelcome", () => {
  it("defaults the welcome switch to enabled when the row has no value", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<HelpAndWelcome adapterId="ad-hw" />)
    await waitFor(() => {
      expect(screen.getByTestId("help-welcome-enabled")).toHaveAttribute("data-state", "checked")
    })
  })

  it("reflects a persisted welcomeCardEnabled=false", async () => {
    await getDb().adapterInstances.put(baseRow({ welcomeCardEnabled: false }))
    render(<HelpAndWelcome adapterId="ad-hw" />)
    await waitFor(() => {
      expect(screen.getByTestId("help-welcome-enabled")).toHaveAttribute("data-state", "unchecked")
    })
  })

  it("persists the toggle when flipped off", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<HelpAndWelcome adapterId="ad-hw" />)
    await waitFor(() => screen.getByTestId("help-welcome-enabled"))
    fireEvent.click(screen.getByTestId("help-welcome-enabled"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-hw")
      expect(row?.welcomeCardEnabled).toBe(false)
    })
  })

  it("persists help triggers (one per line) on blur", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<HelpAndWelcome adapterId="ad-hw" />)
    const ta = await screen.findByTestId("help-welcome-triggers")
    fireEvent.change(ta, { target: { value: "/help\n菜单\n" } })
    fireEvent.blur(ta)
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-hw")
      expect(row?.helpTriggers).toEqual(["/help", "菜单"])
    })
  })

  it("persists a trimmed welcome text on blur", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<HelpAndWelcome adapterId="ad-hw" />)
    const ta = await screen.findByTestId("help-welcome-text")
    fireEvent.change(ta, { target: { value: "  欢迎  " } })
    fireEvent.blur(ta)
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("ad-hw")
      expect(row?.welcomeText).toBe("欢迎")
    })
  })

  it("seeds the editors from persisted values", async () => {
    await getDb().adapterInstances.put(
      baseRow({ helpTriggers: ["a", "b"], welcomeText: "hi there" })
    )
    render(<HelpAndWelcome adapterId="ad-hw" />)
    await waitFor(() => {
      expect((screen.getByTestId("help-welcome-triggers") as HTMLTextAreaElement).value).toBe(
        "a\nb"
      )
      expect((screen.getByTestId("help-welcome-text") as HTMLTextAreaElement).value).toBe(
        "hi there"
      )
    })
  })
})
