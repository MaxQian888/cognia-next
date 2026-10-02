/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const pending = jest.fn()
const respond = jest.fn()
jest.mock("@/lib/codeserver/client", () => ({
  CODESERVER_EVENTS: { relayGrantRequested: "codeserver://relay-grant-requested" },
  codeServerClient: {
    relayGrantPending: () => pending(),
    relayGrantRespond: (id: string, approve: boolean) => respond(id, approve),
  },
}))
const getPairedDevice = jest.fn()
jest.mock("@/lib/db/paired-devices", () => ({
  getPairedDevice: (id: string) => getPairedDevice(id),
}))
let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => mockIsTauri }))
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

import { CodeServerRelayGrantPrompt } from "./code-server-relay-grant-prompt"

const ask = { id: "a1", deviceId: "dev-1", root: "/Users/me/work/acme/", requestedAtMs: 1 }

beforeEach(() => {
  mockIsTauri = true
  handlers = []
  pending.mockReset().mockResolvedValue([])
  respond.mockReset().mockResolvedValue(null)
  getPairedDevice.mockReset().mockResolvedValue({ label: "Ana's iPad" })
})

it("asks the owner, naming the device and the project", async () => {
  pending.mockResolvedValue([ask])
  render(<CodeServerRelayGrantPrompt />)
  expect(await screen.findByTestId("code-server-relay-grant-prompt")).toBeInTheDocument()
  expect(
    screen.getByText(`description:${JSON.stringify({ device: "Ana's iPad", project: "acme" })}`)
  ).toBeInTheDocument()
  expect(screen.getByText(ask.root)).toBeInTheDocument()
  expect(screen.getByText("risk")).toBeInTheDocument()
})

it("falls back to the device id when this desktop has no label for it", async () => {
  pending.mockResolvedValue([ask])
  getPairedDevice.mockResolvedValue(undefined)
  render(<CodeServerRelayGrantPrompt />)
  expect(
    await screen.findByText(`description:${JSON.stringify({ device: "dev-1", project: "acme" })}`)
  ).toBeInTheDocument()
})

it.each([
  ["approve", true],
  ["deny", false],
])("%s answers the ask and re-reads the list", async (button, approve) => {
  pending.mockResolvedValueOnce([ask]).mockResolvedValue([])
  render(<CodeServerRelayGrantPrompt />)
  fireEvent.click(await screen.findByText(button))
  await waitFor(() => expect(respond).toHaveBeenCalledWith("a1", approve))
  await waitFor(() => expect(screen.queryByTestId("code-server-relay-grant-prompt")).toBeNull())
})

it("says so when the ask expired before the owner answered", async () => {
  pending.mockResolvedValue([ask])
  respond.mockRejectedValue(new Error("this request expired or was already answered"))
  render(<CodeServerRelayGrantPrompt />)
  fireEvent.click(await screen.findByText("approve"))
  expect(await screen.findByRole("alert")).toHaveTextContent("failed")
})

it("shows a new ask when the host announces one", async () => {
  render(<CodeServerRelayGrantPrompt />)
  await waitFor(() => expect(pending).toHaveBeenCalledTimes(1))
  expect(screen.queryByTestId("code-server-relay-grant-prompt")).toBeNull()
  pending.mockResolvedValue([ask, { ...ask, id: "a2", root: "/w/other" }])
  await act(async () => {
    for (const handler of handlers) handler()
  })
  expect(await screen.findByTestId("code-server-relay-grant-prompt")).toBeInTheDocument()
  expect(screen.getByText(`more:${JSON.stringify({ count: 1 })}`)).toBeInTheDocument()
})

it("renders nothing and asks nothing outside the desktop shell", async () => {
  mockIsTauri = false
  render(<CodeServerRelayGrantPrompt />)
  await act(async () => {})
  expect(pending).not.toHaveBeenCalled()
  expect(handlers).toHaveLength(0)
})
