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
})
