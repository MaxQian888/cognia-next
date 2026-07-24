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

jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(async () => "secret"),
}))

jest.mock("@/lib/connectors/adapters/lark/surface-sweep", () => ({
  resyncLarkChatSurfaces: jest.fn(async () => ({ synced: 2, errors: 1, skipped: 0 })),
}))

import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { ensureChatSurface, markChatSurfaceError } from "@/lib/db/lark-chat-surfaces"
import { resyncLarkChatSurfaces } from "@/lib/connectors/adapters/lark/surface-sweep"
import { LarkEntrySurfaces } from "./lark-entry-surfaces"

const ADAPTER_ID = "lark-ui-1"

async function seedAdapter(settings: Record<string, unknown> = {}) {
  await getDb().adapterInstances.put({
    id: ADAPTER_ID,
    type: "lark",
    displayName: "UI Bot",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    settings,
  } as never)
}

describe("LarkEntrySurfaces", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("persists the web entry base on blur and flag toggles into settings", async () => {
    await seedAdapter()
    const user = userEvent.setup()
    render(<LarkEntrySurfaces adapterId={ADAPTER_ID} />)

    const input = await screen.findByTestId("lark-web-base-input")
    await user.type(input, "https://cognia.example")
    await user.tab()
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get(ADAPTER_ID)
      expect(row?.settings?.webEntryBaseUrl).toBe("https://cognia.example")
    })

    await user.click(screen.getByTestId("lark-flag-larkChatTab"))
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get(ADAPTER_ID)
      expect(row?.settings?.larkChatTab).toBe(true)
    })
  })

  it("switches the callback authorization mode via the segmented buttons", async () => {
    await seedAdapter()
    const user = userEvent.setup()
    render(<LarkEntrySurfaces adapterId={ADAPTER_ID} />)

    // Default (audit) is highlighted until an explicit choice is stored.
    const enforce = await screen.findByTestId("lark-strict-auth-enforce")
    await user.click(enforce)
    await waitFor(async () => {
      const row = await getDb().adapterInstances.get(ADAPTER_ID)
      expect(row?.settings?.larkStrictCallbackAuthorization).toBe("enforce")
    })
    await waitFor(() => expect(enforce).toHaveAttribute("aria-pressed", "true"))
  })

  it("lists surface rows with status and drives a resync", async () => {
    await seedAdapter({ larkChatTab: true })
    await ensureChatSurface({
      adapterId: ADAPTER_ID,
      chatId: "oc_1",
      surfaceType: "chat_tab",
      urlVersion: 1,
    })
    await markChatSurfaceError(ADAPTER_ID, "oc_1", "chat_tab", "identity_unknown")
    const user = userEvent.setup()
    render(<LarkEntrySurfaces adapterId={ADAPTER_ID} />)

    const rowItem = await screen.findByTestId("lark-surface-oc_1-chat_tab")
    expect(rowItem).toHaveTextContent("oc_1")
    expect(rowItem).toHaveTextContent("status.error")
    expect(rowItem).toHaveTextContent("identity_unknown")

    await user.click(screen.getByTestId("lark-surfaces-resync"))
    await waitFor(() => expect(resyncLarkChatSurfaces).toHaveBeenCalled())
    expect(
      await screen.findByText('resyncDone:{"synced":2,"errors":1,"skipped":0}')
    ).toBeInTheDocument()
    expect((resyncLarkChatSurfaces as jest.Mock).mock.calls[0][0].adapterId).toBe(ADAPTER_ID)
  })

  it("shows the empty state when no surfaces exist", async () => {
    await seedAdapter()
    render(<LarkEntrySurfaces adapterId={ADAPTER_ID} />)
    expect(await screen.findByText("surfacesEmpty")).toBeInTheDocument()
  })
})
