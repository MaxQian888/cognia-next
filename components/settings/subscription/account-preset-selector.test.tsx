/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

import {
  AccountPresetSelector,
  NewAccountPresetSelector,
  providerSupportsPresets,
} from "./account-preset-selector"

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
  it("is true for anthropic + codex + opencode (parity 2026-06-07)", () => {
    expect(providerSupportsPresets("anthropic")).toBe(true)
    expect(providerSupportsPresets("codex")).toBe(true)
    expect(providerSupportsPresets("opencode")).toBe(true)
    expect(providerSupportsPresets("commandcode")).toBe(true)
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe("AccountPresetSelector lifecycle", () => {
  it("reports a failed account/library load and hides the selector", async () => {
    listPresetsMock.mockRejectedValueOnce(new Error("vault locked"))
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed")
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "retry" }))
    expect(await screen.findByRole("combobox")).toHaveTextContent("useDefault")
  })

  it("reports failed writes and retains the saved binding so a retry can succeed", async () => {
    const user = userEvent.setup()
    saveAccountMock.mockRejectedValueOnce(new Error("write failed"))
    render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    await user.click(await screen.findByRole("combobox"))
    await user.click(await screen.findByText("Bedrock"))
    expect(await screen.findByRole("alert")).toHaveTextContent("saveFailed")
    expect(screen.getByRole("combobox")).toHaveTextContent("useDefault")
    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByText("Azure"))
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument())
    expect(screen.getByRole("combobox")).toHaveTextContent("Azure")
  })

  it("clears the previous binding during account switches and ignores stale loads", async () => {
    const slow = deferred<Account | null>()
    const view = render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    await screen.findByRole("combobox")
    getAccountMock.mockReturnValueOnce(slow.promise)
    view.rerender(<AccountPresetSelector provider="codex" accountId="acc-2" />)
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("loading")
    getAccountMock.mockResolvedValueOnce({ ...ACCOUNT, id: "acc-3", presetId: "b" })
    view.rerender(<AccountPresetSelector provider="opencode" accountId="acc-3" />)
    expect(await screen.findByRole("combobox")).toHaveTextContent("Azure")
    await act(async () => slow.resolve({ ...ACCOUNT, id: "acc-2", presetId: "a" }))
    expect(screen.getByRole("combobox")).toHaveTextContent("Azure")
  })

  it("does not save an old selection after its credential load finishes late", async () => {
    const user = userEvent.setup()
    const slow = deferred<Account | null>()
    const view = render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
    await screen.findByRole("combobox")
    getAccountMock.mockReturnValueOnce(slow.promise)
    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByText("Bedrock"))
    view.rerender(<AccountPresetSelector provider="codex" accountId="acc-2" />)
    await screen.findByRole("combobox")
    await act(async () => slow.resolve(ACCOUNT))
    expect(saveAccountMock).not.toHaveBeenCalled()
    expect(screen.getByRole("combobox")).toHaveTextContent("useDefault")
  })

  it.each(["resolve", "reject"] as const)(
    "ignores an old pending save that later %ss",
    async (outcome) => {
      const user = userEvent.setup()
      const slow = deferred<void>()
      saveAccountMock.mockReturnValueOnce(slow.promise)
      const view = render(<AccountPresetSelector provider="anthropic" accountId="acc-1" />)
      await user.click(await screen.findByRole("combobox"))
      await user.click(await screen.findByText("Bedrock"))
      await waitFor(() => expect(saveAccountMock).toHaveBeenCalled())
      view.rerender(<AccountPresetSelector provider="codex" accountId="acc-2" />)
      await screen.findByRole("combobox")
      await act(async () =>
        outcome === "resolve" ? slow.resolve() : slow.reject(new Error("write failed"))
      )
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      expect(screen.getByRole("combobox")).toHaveTextContent("useDefault")
      expect(screen.getByRole("combobox")).not.toBeDisabled()
    }
  )
})

describe("NewAccountPresetSelector", () => {
  it.each(["anthropic", "codex", "opencode", "commandcode"] as const)(
    "selects a %s preset without reading or saving credentials",
    async (provider) => {
      const onChange = jest.fn()
      render(<NewAccountPresetSelector provider={provider} value={null} onChange={onChange} />)
      fireEvent.change(await screen.findByRole("combobox"), { target: { value: "b" } })
      expect(onChange).toHaveBeenCalledWith("b")
      expect(listPresetsMock).toHaveBeenCalledWith(provider)
      expect(getAccountMock).not.toHaveBeenCalled()
      expect(saveAccountMock).not.toHaveBeenCalled()
    }
  )

  it("clears a draft binding to follow the provider default", async () => {
    const onChange = jest.fn()
    render(<NewAccountPresetSelector provider="opencode" value="b" onChange={onChange} />)
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "__default__" } })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it("shows a library load failure", async () => {
    listPresetsMock.mockRejectedValueOnce(new Error("vault unavailable"))
    render(<NewAccountPresetSelector provider="codex" value={null} onChange={jest.fn()} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed")
  })
})
