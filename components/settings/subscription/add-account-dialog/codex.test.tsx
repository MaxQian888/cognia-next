/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { AccountSummary } from "@/types/subscription"

const persistProviderAccountMock = jest.fn()
const replaceAccountCredentialMock = jest.fn()
const requestCodexDeviceCodeMock = jest.fn()
const pollCodexDeviceCodeMock = jest.fn()
const cancelCodexDeviceCodeMock = jest.fn()
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  persistProviderAccount: (...args: unknown[]) => persistProviderAccountMock(...args),
}))
jest.mock("@/lib/subscription/core/transport", () => ({
  reauthenticateManagedCodexAccount: jest.fn(),
  replaceAccountCredential: (...args: unknown[]) => replaceAccountCredentialMock(...args),
}))
jest.mock("@/lib/subscription/codex/oauth", () => ({
  ...jest.requireActual("@/lib/subscription/codex/oauth"),
  cancelCodexDeviceCode: (...args: unknown[]) => cancelCodexDeviceCodeMock(...args),
  pollCodexDeviceCode: (...args: unknown[]) => pollCodexDeviceCodeMock(...args),
  requestCodexDeviceCode: (...args: unknown[]) => requestCodexDeviceCodeMock(...args),
}))

const discovered = {
  source: "file",
  authJsonPath: "/home/user/.codex/auth.json",
  authMode: "ApiKey",
  openaiApiKey: "sk-replacement",
}
jest.mock("@/lib/subscription/codex/hooks", () => ({
  useCodexDiscovery: () => ({
    discovered,
    loading: false,
    error: null,
    reload: jest.fn(),
  }),
}))

jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))

import { CodexAddAccountDialog } from "./codex"

const deviceCode = {
  device_code: "fixture-device",
  user_code: "FIXTURE-1234",
  verification_uri: "http://127.0.0.1:43123/device",
  expires_in: 30,
  interval: 1,
  flow_generation: 7,
}

beforeEach(() => {
  jest.clearAllMocks()
  persistProviderAccountMock.mockImplementation(async (_provider, account) => account)
  replaceAccountCredentialMock.mockImplementation(async (_provider, _accountId, credential) => ({
    id: "existing-id",
    credential,
    createdAtMs: 123,
    lastUsedAtMs: 456,
  }))
  cancelCodexDeviceCodeMock.mockResolvedValue(true)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("CodexAddAccountDialog", () => {
  it("adopts the discovered CLI credential", async () => {
    const onAdded = jest.fn()
    render(<CodexAddAccountDialog open onOpenChange={() => {}} onAdded={onAdded} />)

    await userEvent.click(screen.getByRole("button", { name: /adopt/i }))

    await waitFor(() =>
      expect(persistProviderAccountMock).toHaveBeenCalledWith(
        "codex",
        expect.objectContaining({
          credential: expect.objectContaining({
            provider: "codex",
            accessToken: "sk-replacement",
          }),
        })
      )
    )
    expect(onAdded).toHaveBeenCalled()
  })

  it("replaces credentials while preserving the same ID and metadata", async () => {
    const onUpdated = jest.fn()
    const existing: AccountSummary = {
      id: "existing-id",
      provider: "codex",
      variant: "codex",
      label: "Work",
      expiresAtMs: 0,
      authMode: "api_key",
      credentialSource: "manual",
      health: "ready",
      isExternal: false,
      createdAtMs: 123,
      lastUsedAtMs: 456,
    }
    render(
      <CodexAddAccountDialog
        open
        onOpenChange={() => {}}
        existingAccount={existing}
        onUpdated={onUpdated}
      />
    )

    await userEvent.click(screen.getByRole("button", { name: /adopt/i }))

    await waitFor(() =>
      expect(replaceAccountCredentialMock).toHaveBeenCalledWith(
        "codex",
        "existing-id",
        expect.objectContaining({
          provider: "codex",
          accessToken: "sk-replacement",
          authMode: "api_key",
        })
      )
    )
    expect(persistProviderAccountMock).not.toHaveBeenCalled()
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: "existing-id" }))
  })

  it("retries a transient poll failure on the fixture cadence", async () => {
    jest.useFakeTimers()
    requestCodexDeviceCodeMock.mockResolvedValue(deviceCode)
    pollCodexDeviceCodeMock
      .mockRejectedValueOnce(new Error("fixture network timeout"))
      .mockResolvedValueOnce({ Pending: { error: "authorization_pending" } })
    render(<CodexAddAccountDialog open initialMode="oauth" onOpenChange={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start oauth/i }))
      await Promise.resolve()
    })
    await act(async () => jest.advanceTimersByTimeAsync(1_000))
    expect(pollCodexDeviceCodeMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText("fixture network timeout")).toBeInTheDocument()
    await act(async () => jest.advanceTimersByTimeAsync(1_000))
    expect(pollCodexDeviceCodeMock).toHaveBeenCalledTimes(2)
    jest.useRealTimers()
  })

  it("times out and cancels a fixture device flow", async () => {
    jest.useFakeTimers()
    jest.setSystemTime(1_000)
    requestCodexDeviceCodeMock.mockResolvedValue({ ...deviceCode, expires_in: 1 })
    render(<CodexAddAccountDialog open initialMode="oauth" onOpenChange={() => {}} />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start oauth/i }))
      await Promise.resolve()
    })
    await act(async () => jest.advanceTimersByTimeAsync(2_000))

    expect(pollCodexDeviceCodeMock).not.toHaveBeenCalled()
    expect(cancelCodexDeviceCodeMock).toHaveBeenCalledWith(7)
    expect(screen.getByText(/device code expired/i)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /restart oauth/i })).toBeInTheDocument()
    jest.useRealTimers()
  })

  it("cancels a device generation that arrives after unmount", async () => {
    let resolveRequest!: (value: typeof deviceCode) => void
    requestCodexDeviceCodeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )
    const view = render(<CodexAddAccountDialog open initialMode="oauth" onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /start oauth/i }))
    view.unmount()

    await act(async () => resolveRequest(deviceCode))

    expect(cancelCodexDeviceCodeMock).toHaveBeenCalledWith(7)
    expect(pollCodexDeviceCodeMock).not.toHaveBeenCalled()
  })

  it("ignores a granted response that completes after cancellation", async () => {
    jest.useFakeTimers()
    let resolvePoll!: (value: unknown) => void
    requestCodexDeviceCodeMock.mockResolvedValue(deviceCode)
    pollCodexDeviceCodeMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePoll = resolve
      })
    )
    const view = render(<CodexAddAccountDialog open initialMode="oauth" onOpenChange={() => {}} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start oauth/i }))
      await Promise.resolve()
    })
    await act(async () => jest.advanceTimersByTimeAsync(1_000))
    view.unmount()

    await act(async () =>
      resolvePoll({
        Granted: {
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          id_token: "fixture-id",
          expires_in: 3_600,
        },
      })
    )

    expect(cancelCodexDeviceCodeMock).toHaveBeenCalledWith(7)
    expect(persistProviderAccountMock).not.toHaveBeenCalled()
    jest.useRealTimers()
  })
})
