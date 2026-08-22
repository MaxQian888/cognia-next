/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { LarkWhitelistEditor } from "./lark-whitelist-editor"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

const baseRow = (overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow => ({
  id: "lark-wl",
  type: "lark",
  displayName: "Lark",
  enabled: true,
  transportMode: "webhook",
  settings: {},
  credentialsRef: { keyringService: "com.cognia.platforms", accounts: [] },
  trigger: { rules: [{ kind: "private-default" }], blockers: [], storeUnmatchedInDraftMode: false },
  defaultMode: "auto",
  mediaModelPolicy: "local_extract_only",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe("LarkWhitelistEditor", () => {
  it("renders empty allow/blocklists with empty-state hints", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkWhitelistEditor adapterId="lark-wl" />)
    await waitFor(() => {
      expect(screen.getByTestId("lark-allowlist")).toBeInTheDocument()
      expect(screen.getByTestId("lark-blocklist")).toBeInTheDocument()
    })
  })

  it("adds an allowlist entry and persists", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkWhitelistEditor adapterId="lark-wl" />)
    await waitFor(() => screen.getByTestId("lark-allowlist-input"))
    fireEvent.change(screen.getByTestId("lark-allowlist-input"), {
      target: { value: "oc_team_alpha" },
    })
    fireEvent.click(screen.getByTestId("lark-allowlist-add"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("lark-wl")
      expect(row?.chatAllowlist).toEqual(["oc_team_alpha"])
    })
  })

  it("does not add duplicate ids", async () => {
    await getDb().adapterInstances.put(baseRow({ chatAllowlist: ["oc_dup"] }))
    render(<LarkWhitelistEditor adapterId="lark-wl" />)
    await waitFor(() => screen.getByTestId("lark-allowlist-input"))
    fireEvent.change(screen.getByTestId("lark-allowlist-input"), {
      target: { value: "oc_dup" },
    })
    fireEvent.click(screen.getByTestId("lark-allowlist-add"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("lark-wl")
      expect(row?.chatAllowlist).toEqual(["oc_dup"])
    })
  })

  it("removes an entry via the trailing X button", async () => {
    await getDb().adapterInstances.put(baseRow({ chatBlocklist: ["oc_spam_a", "oc_spam_b"] }))
    render(<LarkWhitelistEditor adapterId="lark-wl" />)
    await waitFor(() => screen.getByTestId("lark-blocklist-item-oc_spam_a"))
    fireEvent.click(screen.getByTestId("lark-blocklist-remove-oc_spam_a"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("lark-wl")
      expect(row?.chatBlocklist).toEqual(["oc_spam_b"])
    })
  })

  it("clears the field after adding (undefined when emptied)", async () => {
    await getDb().adapterInstances.put(baseRow({ chatAllowlist: ["oc_only"] }))
    render(<LarkWhitelistEditor adapterId="lark-wl" />)
    await waitFor(() => screen.getByTestId("lark-allowlist-item-oc_only"))
    fireEvent.click(screen.getByTestId("lark-allowlist-remove-oc_only"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get("lark-wl")
      expect(row?.chatAllowlist).toBeUndefined()
    })
  })
})
