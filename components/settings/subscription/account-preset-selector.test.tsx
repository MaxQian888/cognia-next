/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Account, ProviderPreset } from "@/types/subscription"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const isTauriMock = jest.fn(() => true)
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
}))

const listPresetsMock = jest.fn<Promise<ProviderPreset[]>, [unknown]>()
const getAccountMock = jest.fn<Promise<Account | null>, [unknown, unknown]>()
const saveAccountMock = jest.fn<Promise<void>, [unknown, unknown]>()

jest.mock("@/lib/subscription/core/transport", () => ({
  listPresets: (...a: [unknown]) => listPresetsMock(...a),
  getAccount: (...a: [unknown, unknown]) => getAccountMock(...a),
  saveAccount: (...a: [unknown, unknown]) => saveAccountMock(...a),
}))

import { AccountPresetSelector, providerSupportsPresets } from "./account-preset-selector"

const PRESET_A: ProviderPreset = { id: "a", label: "Bedrock", baseUrl: "https://a.example" }
const PRESET_B: ProviderPreset = { id: "b", label: "Azure", baseUrl: "https://b.example" }

const ACCOUNT: Account = {
  id: "acc-1",
  credential: {
    provider: "anthropic",
    accessToken: "tok",
    refreshToken: "ref",
    expiresAtMs: 0,
    mode: "subscription",
    storedAtMs: 0,
  },
  createdAtMs: 0,
  lastUsedAtMs: 0,
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  listPresetsMock.mockResolvedValue([PRESET_A, PRESET_B])
  getAccountMock.mockResolvedValue({ ...ACCOUNT })
  saveAccountMock.mockResolvedValue(undefined)
})

describe("providerSupportsPresets", () => {
  it("is true for anthropic + codex, false for opencode", () => {
    expect(providerSupportsPresets("anthropic")).toBe(true)
    expect(providerSupportsPresets("codex")).toBe(true)
    expect(providerSupportsPresets("opencode")).toBe(false)
  })
})

describe("AccountPresetSelector", () => {
  it("renders nothing when there are no presets", async () => {
    listPresetsMock.mockResolvedValue([])
    const { container } = render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    await waitFor(() => expect(listPresetsMock).toHaveBeenCalled())
    expect(container.querySelector("[role='combobox']")).toBeNull()
  })

  it("renders the selector defaulting to Use default when account has no binding", async () => {
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    expect(await screen.findByText("useDefault")).toBeInTheDocument()
  })

  it("reflects an existing binding from the account", async () => {
    getAccountMock.mockResolvedValue({ ...ACCOUNT, presetId: "b" })
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    expect(await screen.findByText("Azure")).toBeInTheDocument()
  })

  it("binds a preset: fetches full account, sets presetId, saves", async () => {
    const user = userEvent.setup()
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    await screen.findByText("useDefault")

    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByText("Bedrock"))

    await waitFor(() => expect(saveAccountMock).toHaveBeenCalled())
    const [prov, saved] = saveAccountMock.mock.calls[0] as [string, Account]
    expect(prov).toBe("anthropic")
    expect(saved.presetId).toBe("a")
  })

  it("clears the binding when switching back to Use default", async () => {
    getAccountMock.mockResolvedValue({ ...ACCOUNT, presetId: "a" })
    const user = userEvent.setup()
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    await screen.findByText("Bedrock")

    await user.click(screen.getByRole("combobox"))
    const options = await screen.findAllByText("useDefault")
    await user.click(options[options.length - 1])

    await waitFor(() => expect(saveAccountMock).toHaveBeenCalled())
    const [, saved] = saveAccountMock.mock.calls[0] as [string, Account]
    expect(saved.presetId).toBeUndefined()
  })

  it("does not touch transport outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    // No load attempt, nothing renders (presets stay empty).
    await waitFor(() => expect(listPresetsMock).not.toHaveBeenCalled())
  })

  it("no-ops the save when the account vanished", async () => {
    const user = userEvent.setup()
    // Present at mount, gone at change time.
    getAccountMock.mockResolvedValueOnce({ ...ACCOUNT }).mockResolvedValueOnce(null)
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    await screen.findByText("useDefault")
    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByText("Bedrock"))
    await waitFor(() => expect(getAccountMock).toHaveBeenCalledTimes(2))
    expect(saveAccountMock).not.toHaveBeenCalled()
  })
})
