/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// next-intl is globally mocked against en.json in jest.setup.ts.

let settings: Record<string, unknown> = {}
const saveSettingsMock = jest.fn()
jest.mock("@/lib/db/settings", () => ({
  getSettings: async () => settings,
  saveSettings: (...a: unknown[]) => saveSettingsMock(...a),
}))

const resolveWebDavConfigMock = jest.fn()
jest.mock("@/lib/webdav/config", () => ({
  resolveWebDavConfig: (...a: unknown[]) => resolveWebDavConfigMock(...a),
}))

const runSubscriptionSyncNowMock = jest.fn()
const restoreSubscriptionFromWebDavMock = jest.fn()
const applySubscriptionRestoreMock = jest.fn()
jest.mock("@/lib/subscription/sync/subscription-sync", () => ({
  runSubscriptionSyncNow: (...a: unknown[]) => runSubscriptionSyncNowMock(...a),
  restoreSubscriptionFromWebDav: (...a: unknown[]) => restoreSubscriptionFromWebDavMock(...a),
  applySubscriptionRestore: (...a: unknown[]) => applySubscriptionRestoreMock(...a),
}))

jest.mock("@/lib/subscription/sync/passphrase-cache", () => ({
  getSubscriptionSyncPassphrase: () => null,
  hasSubscriptionSyncPassphrase: () => false,
  loadPersistedSubscriptionSyncPassphrase: async () => false,
}))

import { CloudSyncCard } from "./cloud-sync-card"

beforeEach(() => {
  jest.clearAllMocks()
  settings = {}
  resolveWebDavConfigMock.mockResolvedValue({
    baseUrl: "https://dav.example",
    username: "u",
    remoteDir: "/cognia-backups",
    password: "p",
  })
})

describe("CloudSyncCard", () => {
  it("shows the connection hint when WebDAV is unconfigured", async () => {
    resolveWebDavConfigMock.mockResolvedValue(null)
    render(<CloudSyncCard />)
    expect(await screen.findByText(/Settings → Data/)).toBeInTheDocument()
    // The connection probe must NOT be gated on the data-sync toggle.
    expect(resolveWebDavConfigMock).toHaveBeenCalledWith({ requireEnabled: false })
  })

  it("persists the enable toggle", async () => {
    render(<CloudSyncCard />)
    const toggle = await screen.findByTestId("subscription-cloud-sync-toggle")
    await userEvent.click(toggle)
    await waitFor(() =>
      expect(saveSettingsMock).toHaveBeenCalledWith({
        webdavSync: expect.objectContaining({ subscriptionSyncEnabled: true }),
      })
    )
  })

  it("runs sync-now with the typed passphrase", async () => {
    runSubscriptionSyncNowMock.mockResolvedValue({ ok: true })
    render(<CloudSyncCard />)
    const input = await screen.findByLabelText(/sync passphrase/i)
    await userEvent.type(input, "pw-1")
    await userEvent.click(screen.getByTestId("subscription-cloud-sync-now"))
    await waitFor(() =>
      expect(runSubscriptionSyncNowMock).toHaveBeenCalledWith("pw-1", expect.anything())
    )
  })

  it("disables sync-now while locked and empty", async () => {
    render(<CloudSyncCard />)
    const button = await screen.findByTestId("subscription-cloud-sync-now")
    expect(button).toBeDisabled()
  })

  it("restore flows through preview before applying", async () => {
    restoreSubscriptionFromWebDavMock.mockResolvedValue({
      body: {
        manifest: {
          version: "subscription-v1",
          createdAtIso: "2026-06-07T00:00:00.000Z",
          providers: ["opencode"],
          accountCount: { anthropic: 0, codex: 0, opencode: 2 },
          device: { id: "d", label: "Windows desktop" },
        },
        vaults: {
          opencode: { schemaVersion: 3, accounts: [{ id: "a" }, { id: "b" }], presets: [] },
        },
      },
    })
    applySubscriptionRestoreMock.mockResolvedValue({ accountCount: 2 })

    render(<CloudSyncCard />)
    await userEvent.click(await screen.findByRole("button", { name: /restore/i }))
    const passInput = await screen.findByLabelText(/sync passphrase/i, {
      selector: "#subscription-restore-passphrase",
    })
    await userEvent.type(passInput, "pw")
    await userEvent.click(screen.getByRole("button", { name: /unlock/i }))

    expect(await screen.findByTestId("subscription-restore-preview")).toBeInTheDocument()
    expect(screen.getByText(/Windows desktop/)).toBeInTheDocument()
    expect(applySubscriptionRestoreMock).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", { name: /^restore$/i }))
    await waitFor(() => expect(applySubscriptionRestoreMock).toHaveBeenCalled())
  })

  it("surfaces restore errors inline", async () => {
    restoreSubscriptionFromWebDavMock.mockRejectedValue(new Error("404 not found"))
    render(<CloudSyncCard />)
    await userEvent.click(await screen.findByRole("button", { name: /restore/i }))
    const passInput = await screen.findByLabelText(/sync passphrase/i, {
      selector: "#subscription-restore-passphrase",
    })
    await userEvent.type(passInput, "pw")
    await userEvent.click(screen.getByRole("button", { name: /unlock/i }))
    expect(await screen.findByText(/404 not found/)).toBeInTheDocument()
  })
})
