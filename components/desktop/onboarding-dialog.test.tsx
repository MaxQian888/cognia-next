/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Character } from "@/lib/claude/types"

const logInfo = jest.fn()
const logWarn = jest.fn()
const logError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/logger", () => ({
  loggers: {
    ui: {
      info: (...args: unknown[]) => logInfo(...args),
      warn: (...args: unknown[]) => logWarn(...args),
      error: (...args: unknown[]) => logError(...args),
    },
  },
}))

const charactersRef: { current: Character[] } = { current: [] }
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: <T,>(_q: () => Promise<T> | T, _d: unknown[], _i: T): T =>
    charactersRef.current as unknown as T,
}))

const setApiKey = jest.fn().mockResolvedValue(undefined)
const settingsState: { apiKey?: string } = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { setApiKey: typeof setApiKey; settings: typeof settingsState }) => T
  ): T => selector({ setApiKey, settings: settingsState }),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { OnboardingDialog } from "./onboarding-dialog"

function reset() {
  logInfo.mockReset()
  logWarn.mockReset()
  logError.mockReset()
  toastError.mockReset()
  setApiKey.mockReset().mockResolvedValue(undefined)
  charactersRef.current = []
  settingsState.apiKey = undefined
}

beforeEach(reset)

test("step 1 shows API key form and warns when blank submission", async () => {
  const user = userEvent.setup()
  const onPick = jest.fn()
  const onOpenChange = jest.fn()
  render(<OnboardingDialog open={true} onOpenChange={onOpenChange} onPickCharacter={onPick} />)
  expect(screen.getByText("step1Title")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "continue" }))
  expect(toastError).toHaveBeenCalledWith("toastNeedKey")
  expect(logWarn).toHaveBeenCalledWith("onboarding api key blank")
  expect(setApiKey).not.toHaveBeenCalled()
})

test("submitting a key advances to step 2 and logs", async () => {
  const user = userEvent.setup()
  charactersRef.current = [
    {
      id: "c-1",
      name: "Helper",
      description: "test",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Character,
  ]
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-ant-test")
  await user.click(screen.getByRole("button", { name: "continue" }))
  await waitFor(() => expect(setApiKey).toHaveBeenCalledWith("sk-ant-test"))
  expect(logInfo).toHaveBeenCalledWith(
    "onboarding api key saved",
    expect.objectContaining({ length: 11 })
  )
  expect(screen.getByText("step2Title")).toBeInTheDocument()
})

test("step 2 character pick fires onPickCharacter and closes dialog", async () => {
  const user = userEvent.setup()
  settingsState.apiKey = "preset-key"
  charactersRef.current = [
    {
      id: "c-1",
      name: "Helper",
      description: "",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Character,
    {
      id: "c-2",
      name: "Other",
      description: "",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Character,
  ]
  const onPick = jest.fn()
  const onOpenChange = jest.fn()
  render(<OnboardingDialog open={true} onOpenChange={onOpenChange} onPickCharacter={onPick} />)
  await user.click(screen.getByText("Helper"))
  expect(onPick).toHaveBeenCalledWith(charactersRef.current[0])
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(logInfo).toHaveBeenCalledWith(
    "onboarding pick character",
    expect.objectContaining({ characterId: "c-1" })
  )
})

test("Skip button on step 1 closes the dialog and logs", async () => {
  const user = userEvent.setup()
  const onOpenChange = jest.fn()
  render(<OnboardingDialog open={true} onOpenChange={onOpenChange} onPickCharacter={jest.fn()} />)
  await user.click(screen.getByRole("button", { name: "skip" }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(logInfo).toHaveBeenCalledWith("onboarding skip", { step: 1 })
})

test("API key save error is logged and toasted", async () => {
  const user = userEvent.setup()
  setApiKey.mockRejectedValueOnce(new Error("nope"))
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-test")
  await user.click(screen.getByRole("button", { name: "continue" }))
  await waitFor(() => expect(logError).toHaveBeenCalled())
  expect(toastError).toHaveBeenCalledWith("nope")
})
