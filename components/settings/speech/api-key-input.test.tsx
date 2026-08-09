/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { ApiKeyInput } from "./api-key-input"

const ensureProviderKeys = jest.fn().mockResolvedValue(undefined)
const setProviderApiKey = jest.fn().mockResolvedValue(undefined)
const clearProviderApiKey = jest.fn().mockResolvedValue(undefined)

const storeState = {
  providerKeys: {} as Record<string, string>,
  setProviderApiKey,
  clearProviderApiKey,
  ensureProviderKeys,
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: typeof storeState) => T): T => selector(storeState),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

jest.mock("@cognia/logging", () => ({
  loggers: { tts: { info: jest.fn(), error: jest.fn() } },
}))

beforeEach(() => {
  ensureProviderKeys.mockClear()
  setProviderApiKey.mockClear()
  clearProviderApiKey.mockClear()
  toastSuccess.mockClear()
  toastError.mockClear()
  storeState.providerKeys = {}
})

test("triggers the lazy provider-key load on mount", () => {
  // Keys are no longer loaded at app boot; the settings UI pulls them on mount.
  render(<ApiKeyInput provider="openai" label="OpenAI" />)
  expect(ensureProviderKeys).toHaveBeenCalledTimes(1)
})

test("shows the not-configured badge and disables Save until edited", () => {
  render(<ApiKeyInput provider="openai" label="OpenAI" />)
  expect(screen.getByText("notConfigured")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
})

test("shows the configured badge and a Clear button when a key is stored", () => {
  storeState.providerKeys = { openai: "sk-stored" }
  render(<ApiKeyInput provider="openai" label="OpenAI" />)
  expect(screen.getByText("configured")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "clear" })).toBeInTheDocument()
})

test("saves an edited key via the store and toasts success", async () => {
  const { container } = render(<ApiKeyInput provider="openai" label="OpenAI" />)
  const input = container.querySelector("input") as HTMLInputElement
  fireEvent.change(input, { target: { value: "sk-new" } })
  const save = screen.getByRole("button", { name: "save" })
  expect(save).not.toBeDisabled()
  fireEvent.click(save)
  await waitFor(() => expect(setProviderApiKey).toHaveBeenCalledWith("openai", "sk-new"))
  expect(toastSuccess).toHaveBeenCalled()
})

test("clears a stored key via the store and toasts success", async () => {
  storeState.providerKeys = { openai: "sk-stored" }
  render(<ApiKeyInput provider="openai" label="OpenAI" />)
  fireEvent.click(screen.getByRole("button", { name: "clear" }))
  await waitFor(() => expect(clearProviderApiKey).toHaveBeenCalledWith("openai"))
  expect(toastSuccess).toHaveBeenCalled()
})

test("toggles key visibility between password and text", () => {
  const { container } = render(<ApiKeyInput provider="openai" label="OpenAI" />)
  const input = container.querySelector("input") as HTMLInputElement
  expect(input.type).toBe("password")
  fireEvent.click(screen.getByRole("button", { name: "showKey" }))
  expect(input.type).toBe("text")
})

test("shows desktop key presence without exposing the key value", () => {
  storeState.providerKeys = { openai: "__cognia_host_key_present__" }
  const { container } = render(<ApiKeyInput provider="openai" label="OpenAI" />)
  expect((container.querySelector("input") as HTMLInputElement).value).toBe("")
  expect(screen.getByText("configured")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "clear" })).toBeInTheDocument()
})
