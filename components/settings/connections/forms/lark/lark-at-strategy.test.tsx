/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { LarkAtStrategy } from "./lark-at-strategy"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

const baseRow = (overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow => ({
  id: "lark-as",
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

describe("LarkAtStrategy", () => {
  it("selects mention_only by default when the row has no strategy", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => {
      expect(screen.getByTestId("lark-at-mention_only")).toHaveAttribute("data-state", "checked")
    })
  })

  it("selects the persisted strategy when set", async () => {
    await getDb().adapterInstances.put(baseRow({ atResponseStrategy: "always" }))
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => {
      expect(screen.getByTestId("lark-at-always")).toHaveAttribute("data-state", "checked")
    })
  })

  it("persists the new strategy when the operator picks one", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => screen.getByTestId("lark-at-direct_only"))
    fireEvent.click(screen.getByTestId("lark-at-direct_only"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("lark-as")
      expect(row?.atResponseStrategy).toBe("direct_only")
    })
  })

  // ── Sibling-bot policy (W5 multi-bot same-group) ──

  it("selects the ignore sibling policy by default and hides the budget input", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => {
      expect(screen.getByTestId("sibling-policy-ignore")).toHaveAttribute("data-state", "checked")
    })
    expect(screen.queryByTestId("sibling-budget-input")).not.toBeInTheDocument()
  })

  it("persists siblingBotPolicy when the operator picks respond", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => screen.getByTestId("sibling-policy-respond"))
    fireEvent.click(screen.getByTestId("sibling-policy-respond"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("lark-as")
      expect(row?.siblingBotPolicy).toBe("respond")
    })
  })

  it("shows the budget input for respond and persists botInterplayBudget", async () => {
    await getDb().adapterInstances.put(baseRow({ siblingBotPolicy: "respond" }))
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => screen.getByTestId("sibling-budget-input"))
    // Default budget shown when the row carries none.
    expect(screen.getByTestId("sibling-budget-input")).toHaveValue(4)
    fireEvent.change(screen.getByTestId("sibling-budget-input"), { target: { value: "7" } })
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("lark-as")
      expect(row?.botInterplayBudget).toBe(7)
    })
  })

  it("does not persist an invalid budget", async () => {
    await getDb().adapterInstances.put(baseRow({ siblingBotPolicy: "respond" }))
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => screen.getByTestId("sibling-budget-input"))
    fireEvent.change(screen.getByTestId("sibling-budget-input"), { target: { value: "0" } })
    fireEvent.change(screen.getByTestId("sibling-budget-input"), { target: { value: "" } })
    // Give any (wrong) write a chance to land, then assert nothing persisted.
    await new Promise((r) => setTimeout(r, 50))
    const row = await getDb().adapterInstances.get("lark-as")
    expect(row?.botInterplayBudget).toBeUndefined()
  })

  it("reflects a persisted respond policy with its stored budget", async () => {
    await getDb().adapterInstances.put(
      baseRow({ siblingBotPolicy: "respond", botInterplayBudget: 9 })
    )
    render(<LarkAtStrategy adapterId="lark-as" />)
    await waitFor(() => {
      expect(screen.getByTestId("sibling-policy-respond")).toHaveAttribute("data-state", "checked")
    })
    expect(screen.getByTestId("sibling-budget-input")).toHaveValue(9)
  })
})
