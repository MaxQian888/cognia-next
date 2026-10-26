/** @jest-environment jsdom */
import { getNativeSelect, selectOption } from "@/lib/testing/select-option"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SiwcConnections } from "./siwc-connections"
import * as api from "@/lib/subscription/siwc/transport"
import * as execution from "@/lib/subscription/siwc/execution"
import type { SiwcConnectionSummary } from "@/types/subscription/siwc"
import { useAccountStore } from "@/stores/account/account-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/lib/subscription/siwc/transport", () => ({
  listSiwcConnections: jest.fn(),
  beginSiwcLogin: jest.fn(),
  pollSiwcLogin: jest.fn(),
  cancelSiwcLogin: jest.fn(),
  refreshSiwcConnection: jest.fn(),
  signOutSiwcConnection: jest.fn(),
  deleteSiwcConnection: jest.fn(),
  listSiwcModels: jest.fn(),
}))
jest.mock("@/lib/subscription/siwc/execution", () => ({
  configureSiwcChatConnection: jest.fn(),
  configureSiwcAppServerConnection: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
let mockLocalAccountId: string | null = "local-a"
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: Object.assign(
    (selector: (state: { unlockedAccountId: string | null }) => unknown) =>
      selector({ unlockedAccountId: mockLocalAccountId }),
    {
      getState: () => ({ unlockedAccountId: mockLocalAccountId }),
      subscribe: jest.fn(() => () => undefined),
    }
  ),
}))

const connection = (
  id = "registration-a",
  over: Partial<SiwcConnectionSummary> = {}
): SiwcConnectionSummary => ({
  id,
  label: "ChatGPT",
  email: "same@example.test",
  issuer: "https://auth.openai.com",
  subject: "subject-a",
  issuedClientId: `client-${id}`,
  status: "connected",
  scopes: [],
  expiresAtMs: 1000,
  planPermission: true,
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockLocalAccountId = "local-a"
  jest.mocked(api.listSiwcConnections).mockResolvedValue([])
  jest.mocked(api.cancelSiwcLogin).mockResolvedValue(undefined)
  jest
    .mocked(api.listSiwcModels)
    .mockResolvedValue([{ slug: "gpt-test", displayName: "Test GPT", visibility: "list" }])
  jest.mocked(execution.configureSiwcChatConnection).mockResolvedValue(undefined)
  jest.mocked(execution.configureSiwcAppServerConnection).mockResolvedValue(undefined)
})

it("reads isolated summaries without starting login, refreshing, or configuring execution", async () => {
  render(<SiwcConnections />)
  await screen.findByText("empty")
  expect(api.listSiwcConnections).toHaveBeenCalledTimes(1)
  expect(api.beginSiwcLogin).not.toHaveBeenCalled()
  expect(api.refreshSiwcConnection).not.toHaveBeenCalled()
  expect(execution.configureSiwcChatConnection).not.toHaveBeenCalled()
})

it("does not read or create a store while the local account is locked", () => {
  mockLocalAccountId = null
  render(<SiwcConnections />)
  expect(screen.getByText("locked")).toBeInTheDocument()
  expect(api.listSiwcConnections).not.toHaveBeenCalled()
})

it("keeps same-email registrations distinct and requires explicit model and route selection", async () => {
  jest
    .mocked(api.listSiwcConnections)
    .mockResolvedValue([connection(), connection("registration-b")])
  render(<SiwcConnections />)
  const rows = await screen.findAllByRole("article")
  expect(rows).toHaveLength(2)
  expect(within(rows[0]).getByText("registration-a")).toBeInTheDocument()
  expect(within(rows[1]).getByText("registration-b")).toBeInTheDocument()
  fireEvent.click(within(rows[1]).getByRole("button", { name: "models" }))
  const select = await within(rows[1]).findByRole("combobox", { name: "model" })
  expect(within(rows[1]).getByRole("button", { name: "enableChat" })).toBeDisabled()
  await selectOption(select, "gpt-test")
  fireEvent.click(within(rows[1]).getByRole("button", { name: "enableChat" }))
  await waitFor(() =>
    expect(execution.configureSiwcChatConnection).toHaveBeenCalledWith(
      connection("registration-b"),
      "gpt-test"
    )
  )
  expect(execution.configureSiwcAppServerConnection).not.toHaveBeenCalled()
})

it("disables inference for identity-only or signed-out connections", async () => {
  jest
    .mocked(api.listSiwcConnections)
    .mockResolvedValue([
      connection("identity-only", { planPermission: false, status: "plan_disabled" }),
      connection("signed-out", { status: "signed_out" }),
    ])
  render(<SiwcConnections />)
  for (const row of await screen.findAllByRole("article")) {
    expect(within(row).getByRole("button", { name: "models" })).toBeDisabled()
  }
  expect(screen.getByText("planUnavailable")).toBeInTheDocument()
})

it("lists only catalog entries with the documented list visibility", async () => {
  jest.mocked(api.listSiwcConnections).mockResolvedValue([connection()])
  jest.mocked(api.listSiwcModels).mockResolvedValue([
    { slug: "public", displayName: "Public model", visibility: "list" },
    { slug: "internal", displayName: "Internal model", visibility: "hide" },
  ])
  render(<SiwcConnections />)
  const row = await screen.findByRole("article")
  fireEvent.click(within(row).getByRole("button", { name: "models" }))
  const select = await within(row).findByRole("combobox", { name: "model" })
  expect(
    within(getNativeSelect(select)).getByRole("option", { hidden: true, name: "Public model" })
  ).toBeInTheDocument()
  expect(
    within(getNativeSelect(select)).queryByRole("option", { hidden: true, name: "Internal model" })
  ).not.toBeInTheDocument()
})

it("cancels a pending native login on unmount in its original scope", async () => {
  jest.mocked(api.beginSiwcLogin).mockResolvedValue({ attemptId: "attempt-a" })
  jest.mocked(api.pollSiwcLogin).mockResolvedValue({ status: "pending" })
  const view = render(<SiwcConnections />)
  await screen.findByText("empty")
  fireEvent.click(screen.getByRole("button", { name: "add" }))
  await waitFor(() => expect(api.pollSiwcLogin).toHaveBeenCalledWith("attempt-a"))
  view.unmount()
  expect(api.cancelSiwcLogin).toHaveBeenCalledWith("attempt-a", "local-a")
})

it("cancels a late begin response after switching local accounts without showing its connection", async () => {
  let finish!: (value: { attemptId: string }) => void
  jest.mocked(api.beginSiwcLogin).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const view = render(<SiwcConnections />)
  await screen.findByText("empty")
  fireEvent.click(screen.getByRole("button", { name: "add" }))
  mockLocalAccountId = "local-b"
  view.rerender(<SiwcConnections />)
  await act(async () => finish({ attemptId: "late-attempt" }))
  expect(api.cancelSiwcLogin).toHaveBeenCalledWith("late-attempt", "local-a")
  expect(api.pollSiwcLogin).not.toHaveBeenCalled()
  expect(screen.queryByText("signedIn")).not.toBeInTheDocument()
})

it("exposes cancel while begin is pending and never polls a cancelled late attempt", async () => {
  let finish!: (value: { attemptId: string }) => void
  jest.mocked(api.beginSiwcLogin).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(<SiwcConnections />)
  await screen.findByText("empty")
  fireEvent.click(screen.getByRole("button", { name: "add" }))
  fireEvent.click(screen.getByRole("button", { name: "cancel" }))
  await act(async () => finish({ attemptId: "cancelled-late" }))
  expect(api.cancelSiwcLogin).toHaveBeenCalledWith("cancelled-late", "local-a")
  expect(api.pollSiwcLogin).not.toHaveBeenCalled()
})

it("discloses unconfirmed remote revocation and retains the separate local record", async () => {
  jest.mocked(api.listSiwcConnections).mockResolvedValue([connection()])
  jest.mocked(api.signOutSiwcConnection).mockResolvedValue({ revocation: "unconfirmed" })
  render(<SiwcConnections />)
  const row = (await screen.findAllByRole("article"))[0]
  fireEvent.click(within(row).getByRole("button", { name: "signOut" }))
  await screen.findByText("revocationUnconfirmed")
  expect(api.deleteSiwcConnection).not.toHaveBeenCalled()
})

it("requires a confirmation before deleting an independent registration", async () => {
  jest
    .mocked(api.listSiwcConnections)
    .mockResolvedValue([connection("signed-out", { status: "signed_out" })])
  jest.mocked(api.deleteSiwcConnection).mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<SiwcConnections />)
  const row = (await screen.findAllByRole("article"))[0]
  await user.click(within(row).getByRole("button", { name: "remove" }))
  expect(api.deleteSiwcConnection).not.toHaveBeenCalled()
  const dialog = screen.getByRole("alertdialog")
  await user.click(within(dialog).getByRole("button", { name: "removeConfirm" }))
  await waitFor(() => expect(api.deleteSiwcConnection).toHaveBeenCalledWith("signed-out"))
})

it("serializes duplicate login clicks and publishes only its completed registration", async () => {
  let finish!: (value: { attemptId: string }) => void
  jest.mocked(api.beginSiwcLogin).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  jest.mocked(api.pollSiwcLogin).mockResolvedValue({ status: "complete", connection: connection() })
  render(<SiwcConnections />)
  await screen.findByText("empty")
  const button = screen.getByRole("button", { name: "add" })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(api.beginSiwcLogin).toHaveBeenCalledTimes(1)
  jest.mocked(api.listSiwcConnections).mockResolvedValue([connection()])
  await act(async () => finish({ attemptId: "attempt-a" }))
  await screen.findByText("signedIn")
  expect(screen.getByRole("article")).toHaveTextContent("registration-a")
  expect(execution.configureSiwcChatConnection).not.toHaveBeenCalled()
})

it("ignores a stale model catalog after an account switch", async () => {
  jest.mocked(api.listSiwcConnections).mockResolvedValueOnce([connection()]).mockResolvedValue([])
  let finish!: (value: Awaited<ReturnType<typeof api.listSiwcModels>>) => void
  jest.mocked(api.listSiwcModels).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const view = render(<SiwcConnections />)
  const row = (await screen.findAllByRole("article"))[0]
  fireEvent.click(within(row).getByRole("button", { name: "models" }))
  mockLocalAccountId = "local-b"
  view.rerender(<SiwcConnections />)
  await act(async () => finish([{ slug: "stale", displayName: "Stale model", visibility: "list" }]))
  expect(screen.queryByText("Stale model")).not.toBeInTheDocument()
  expect(screen.queryByRole("article")).not.toBeInTheDocument()
})

it("invalidates pending work on an ABA local account switch even if React batches the render", async () => {
  let finish!: (value: { attemptId: string }) => void
  jest.mocked(api.beginSiwcLogin).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(<SiwcConnections />)
  await screen.findByText("empty")
  fireEvent.click(screen.getByRole("button", { name: "add" }))
  const listener = jest.mocked(useAccountStore.subscribe).mock.calls[0][0]
  await act(async () => {
    listener({ unlockedAccountId: "local-b" } as never, { unlockedAccountId: "local-a" } as never)
    listener({ unlockedAccountId: "local-a" } as never, { unlockedAccountId: "local-b" } as never)
  })
  await act(async () => finish({ attemptId: "aba-attempt" }))
  expect(api.cancelSiwcLogin).toHaveBeenCalledWith("aba-attempt", "local-a")
  expect(api.pollSiwcLogin).not.toHaveBeenCalled()
})

it("does not expose native error details that might contain credentials", async () => {
  jest.mocked(api.beginSiwcLogin).mockRejectedValue(new Error("sensitive-token-fixture"))
  render(<SiwcConnections />)
  await screen.findByText("empty")
  fireEvent.click(screen.getByRole("button", { name: "add" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("operationFailed")
  expect(screen.queryByText(/sensitive-token-fixture/)).not.toBeInTheDocument()
})

it("retries the issued-client draft after exchange failure instead of registering again", async () => {
  jest.mocked(api.beginSiwcLogin).mockResolvedValue({ attemptId: "attempt-a" })
  jest.mocked(api.pollSiwcLogin).mockResolvedValue({
    status: "error",
    safeCode: "exchange_failed",
    retryConnectionId: "draft-issued-a",
  })
  render(<SiwcConnections />)
  await screen.findByText("empty")
  fireEvent.click(screen.getByRole("button", { name: "add" }))
  fireEvent.click(await screen.findByRole("button", { name: "retrySignIn" }))
  await waitFor(() => expect(api.beginSiwcLogin).toHaveBeenLastCalledWith("draft-issued-a"))
})
