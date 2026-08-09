/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Account } from "@/types/subscription"

const persistProviderAccountMock = jest.fn()
jest.mock("@/lib/subscription/core/account-lifecycle", () => ({
  persistProviderAccount: (...args: unknown[]) => persistProviderAccountMock(...args),
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

beforeEach(() => {
  jest.clearAllMocks()
  persistProviderAccountMock.mockImplementation(async (_provider, account) => account)
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
    const existing: Account = {
      id: "existing-id",
      label: "Work",
      credential: {
        provider: "codex",
        accessToken: "old",
        refreshToken: "",
        idTokenRaw: "",
        expiresAtMs: 0,
        authMode: "api_key",
        storedAtMs: 0,
      },
      createdAtMs: 123,
      lastUsedAtMs: 456,
      presetId: "preset-1",
    }
    render(<CodexAddAccountDialog open onOpenChange={() => {}} existingAccount={existing} />)

    await userEvent.click(screen.getByRole("button", { name: /adopt/i }))

    await waitFor(() =>
      expect(persistProviderAccountMock).toHaveBeenCalledWith(
        "codex",
        expect.objectContaining({
          id: "existing-id",
          label: "Work",
          createdAtMs: 123,
          presetId: "preset-1",
        })
      )
    )
  })
})
