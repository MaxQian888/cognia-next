/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { LarkWhoamiPanel } from "./lark-whoami-panel"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

jest.mock("@/lib/connectors/adapters/lark/whoami", () => ({
  probeBotIdentity: jest.fn(),
  LarkWhoamiError: class extends Error {},
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

const baseRow = (overrides: Partial<AdapterInstanceRow> = {}): AdapterInstanceRow => ({
  id: "lark-wh",
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

describe("LarkWhoamiPanel", () => {
  it("renders the unknown empty state when the row has no whoami snapshot", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkWhoamiPanel adapterId="lark-wh" />)
    await waitFor(() => {
      expect(screen.getByTestId("lark-whoami-empty")).toBeInTheDocument()
    })
  })

  it("renders the bot identity when lastWhoamiResult is present", async () => {
    await getDb().adapterInstances.put(
      baseRow({
        lastWhoamiAt: 1_700_000_000_000,
        lastWhoamiResult: {
          botName: "Cognia Bot",
          appId: "cli_abc",
          openId: "ou_x",
          tenantKey: "tnt_y",
          activateStatus: 2,
          scopes: ["im:message", "bot:info"],
        },
      })
    )
    render(<LarkWhoamiPanel adapterId="lark-wh" />)
    await waitFor(() => {
      expect(screen.getByText("Cognia Bot")).toBeInTheDocument()
      expect(screen.getByText("cli_abc")).toBeInTheDocument()
      expect(screen.getByText("ou_x")).toBeInTheDocument()
      expect(screen.getByText("im:message")).toBeInTheDocument()
    })
  })

  it("renders the missing-scopes warning when chat-management calls recorded gaps", async () => {
    await getDb().adapterInstances.put(
      baseRow({ lastMissingScopes: ["im:chat:create", "contact:user.id:readonly"] })
    )
    render(<LarkWhoamiPanel adapterId="lark-wh" />)
    await waitFor(() => {
      const warning = screen.getByTestId("lark-whoami-missing-scopes")
      expect(warning).toBeInTheDocument()
      expect(screen.getByText("im:chat:create")).toBeInTheDocument()
      expect(screen.getByText("contact:user.id:readonly")).toBeInTheDocument()
    })
  })

  it("omits the missing-scopes warning when the list is empty", async () => {
    await getDb().adapterInstances.put(baseRow({ lastMissingScopes: [] }))
    render(<LarkWhoamiPanel adapterId="lark-wh" />)
    await waitFor(() => {
      expect(screen.getByTestId("lark-whoami-empty")).toBeInTheDocument()
    })
    expect(screen.queryByTestId("lark-whoami-missing-scopes")).not.toBeInTheDocument()
  })

  it("disables the Re-probe button on web (non-Tauri) runtime", async () => {
    await getDb().adapterInstances.put(baseRow())
    render(<LarkWhoamiPanel adapterId="lark-wh" />)
    await waitFor(() => {
      const btn = screen.getByTestId("lark-whoami-reprobe")
      expect(btn).toBeDisabled()
      expect(screen.getByTestId("lark-whoami-desktop-only")).toBeInTheDocument()
    })
  })
})
