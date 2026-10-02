/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))
const grants = jest.fn()
const revoke = jest.fn()
jest.mock("@/lib/codeserver/client", () => ({
  CODESERVER_EVENTS: { relayGrantRequested: "codeserver://relay-grant-requested" },
  codeServerClient: {
    relayGrants: () => grants(),
    relayGrantRevoke: (deviceId: string, root: string) => revoke(deviceId, root),
  },
}))
jest.mock("@/lib/db/paired-devices", () => ({
  getPairedDevice: async (id: string) => (id === "dev-1" ? { label: "Ana's iPad" } : undefined),
}))
let handlers: (() => void)[] = []
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: (_name: string, handler: () => void) => {
    handlers.push(handler)
    return Promise.resolve(() => undefined)
  },
}))
jest.mock("@/lib/tauri/safe-unlisten", () => ({
  safeUnlisten: (fn: (() => void) | null) => fn?.(),
}))

import { ProIdeRelayGrants } from "./pro-ide-relay-grants"

const GRANTED = Date.UTC(2026, 9, 1)

beforeEach(() => {
  handlers = []
  grants.mockReset()
  revoke.mockReset().mockResolvedValue(true)
  toastSuccess.mockClear()
  toastError.mockClear()
})

it("says when no device may open VS Code here", async () => {
  grants.mockResolvedValue([])
  render(<ProIdeRelayGrants />)
  expect(await screen.findByTestId("pro-ide-relay-grants-empty")).toBeInTheDocument()
})

it("lists each approval by device name, falling back to its id, with its folder", async () => {
  grants.mockResolvedValue([
    { deviceId: "dev-1", root: "/w/acme", grantedAtMs: GRANTED },
    { deviceId: "dev-2", root: "/w/other", grantedAtMs: GRANTED },
  ])
  render(<ProIdeRelayGrants />)
  const rows = await screen.findAllByTestId("pro-ide-relay-grant")
  expect(rows).toHaveLength(2)
  expect(rows[0]).toHaveTextContent("Ana's iPad")
  expect(rows[0]).toHaveTextContent("/w/acme")
  expect(rows[1]).toHaveTextContent("dev-2")
  expect(rows[0]).toHaveTextContent(/relayGrantsGrantedAt:.*2026/)
})

it("revokes one approval and re-reads the list", async () => {
  grants
    .mockResolvedValueOnce([{ deviceId: "dev-1", root: "/w/acme", grantedAtMs: GRANTED }])
    .mockResolvedValue([])
  render(<ProIdeRelayGrants />)
  fireEvent.click(
    await screen.findByLabelText(
      `relayGrantsRevokeLabel:${JSON.stringify({ device: "Ana's iPad" })}`
    )
  )
  await waitFor(() => expect(revoke).toHaveBeenCalledWith("dev-1", "/w/acme"))
  expect(toastSuccess).toHaveBeenCalledWith("relayGrantsRevoked")
  expect(await screen.findByTestId("pro-ide-relay-grants-empty")).toBeInTheDocument()
})

it("reports a failed revoke", async () => {
  grants.mockResolvedValue([{ deviceId: "dev-1", root: "/w/acme", grantedAtMs: GRANTED }])
  revoke.mockRejectedValue(new Error("disk full"))
  render(<ProIdeRelayGrants />)
  fireEvent.click(await screen.findByRole("button"))
  await waitFor(() => expect(toastError).toHaveBeenCalled())
  expect(toastError.mock.calls[0][0]).toMatch(/relayGrantsRevokeFailed:.*disk full/)
})

it("re-reads when a device asks, since the owner is about to answer", async () => {
  grants.mockResolvedValue([])
  render(<ProIdeRelayGrants />)
  await waitFor(() => expect(grants).toHaveBeenCalledTimes(1))
  await act(async () => {
    for (const handler of handlers) handler()
  })
  expect(grants).toHaveBeenCalledTimes(2)
})
