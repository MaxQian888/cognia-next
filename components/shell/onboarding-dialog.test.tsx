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
  useTranslations: () => (key: string, params?: Record<string, string | number>) => {
    if (!params) return key
    return `${key}:${Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(",")}`
  },
}))

jest.mock("@cognia/logging", () => ({
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
const dismissOnboarding = jest.fn().mockResolvedValue(undefined)

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: { setApiKey: typeof setApiKey; dismissOnboarding: typeof dismissOnboarding }) => T
  ): T => selector({ setApiKey, dismissOnboarding }),
}))

const setActiveAccount = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/subscription/core/transport", () => ({
  setActiveAccount: (...args: unknown[]) => setActiveAccount(...args),
}))

const anthropicAddedRef: { onAdded?: (account: { id: string }) => void } = {}
const codexAddedRef: { onAdded?: (account: { id: string }) => void } = {}
const opencodeAddedRef: { onAdded?: (account: { id: string }) => void } = {}

jest.mock("@/components/settings/subscription/add-account-dialog/anthropic", () => ({
  AnthropicAddAccountDialog: ({
    open,
    onAdded,
  }: {
    open: boolean
    onAdded?: (account: { id: string }) => void
  }) => {
    anthropicAddedRef.onAdded = onAdded
    return open ? <div data-testid="mock-anthropic-dialog" /> : null
  },
}))
jest.mock("@/components/settings/subscription/add-account-dialog/codex", () => ({
  CodexAddAccountDialog: ({
    open,
    onAdded,
  }: {
    open: boolean
    onAdded?: (account: { id: string }) => void
  }) => {
    codexAddedRef.onAdded = onAdded
    return open ? <div data-testid="mock-codex-dialog" /> : null
  },
}))
jest.mock("@/components/settings/subscription/add-account-dialog/opencode", () => ({
  OpencodeAddAccountDialog: ({
    open,
    onAdded,
  }: {
    open: boolean
    onAdded?: (account: { id: string }) => void
  }) => {
    opencodeAddedRef.onAdded = onAdded
    return open ? <div data-testid="mock-opencode-dialog" /> : null
  },
}))

const routerPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...args: unknown[]) => routerPush(...args) }),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}))

// Keep the shared motion/react mock (merges `animate` into style, jsdom-safe)
// but make reduced-motion controllable so the `reduce ? …` entrance branches
// in each step get exercised.
jest.mock("motion/react", () => {
  const actual = jest.requireActual("motion/react")
  return { ...actual, useReducedMotion: jest.fn(() => false) }
})

import { OnboardingDialog } from "./onboarding-dialog"
import { useReducedMotion } from "motion/react"
const mockUseReducedMotion = useReducedMotion as jest.Mock

function reset() {
  logInfo.mockReset()
  logWarn.mockReset()
  logError.mockReset()
  toastError.mockReset()
  routerPush.mockReset()
  setApiKey.mockReset().mockResolvedValue(undefined)
  dismissOnboarding.mockReset().mockResolvedValue(undefined)
  setActiveAccount.mockReset().mockResolvedValue(undefined)
  anthropicAddedRef.onAdded = undefined
  codexAddedRef.onAdded = undefined
  opencodeAddedRef.onAdded = undefined
  mockUseReducedMotion.mockReturnValue(false)
  charactersRef.current = [
    {
      id: "c-1",
      name: "Helper",
      description: "test",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as Character,
  ]
}

beforeEach(reset)

test("provider step renders all four sign-in cards", () => {
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  expect(screen.getByText("step1Title")).toBeInTheDocument()
  expect(screen.getByTestId("onboarding-provider-claude")).toBeInTheDocument()
  expect(screen.getByTestId("onboarding-provider-codex")).toBeInTheDocument()
  expect(screen.getByTestId("onboarding-provider-opencode")).toBeInTheDocument()
  expect(screen.getByTestId("onboarding-provider-apiKey")).toBeInTheDocument()
})

test("clicking Claude card opens the Anthropic add-account dialog", async () => {
  const user = userEvent.setup()
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await user.click(screen.getByTestId("onboarding-provider-claude"))
  expect(screen.getByTestId("mock-anthropic-dialog")).toBeInTheDocument()
  expect(logInfo).toHaveBeenCalledWith("onboarding provider chosen", { choice: "claude" })
})

test("Anthropic onAdded activates account, advances to character step", async () => {
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  // Open the dialog
  await userEvent.setup().click(screen.getByTestId("onboarding-provider-claude"))
  // Fire the onAdded callback (simulating successful PKCE)
  anthropicAddedRef.onAdded?.({ id: "acct-1" })
  await waitFor(() => {
    expect(setActiveAccount).toHaveBeenCalledWith("anthropic", "acct-1")
  })
  await waitFor(() => {
    expect(screen.getByText("step2Title")).toBeInTheDocument()
  })
})

test("Codex onAdded activates account on codex provider", async () => {
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await userEvent.setup().click(screen.getByTestId("onboarding-provider-codex"))
  codexAddedRef.onAdded?.({ id: "acct-2" })
  await waitFor(() => expect(setActiveAccount).toHaveBeenCalledWith("codex", "acct-2"))
})

test("OpenCode onAdded activates account on opencode provider", async () => {
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await userEvent.setup().click(screen.getByTestId("onboarding-provider-opencode"))
  opencodeAddedRef.onAdded?.({ id: "acct-3" })
  await waitFor(() => expect(setActiveAccount).toHaveBeenCalledWith("opencode", "acct-3"))
})

test("API key paste path saves key and advances to character step", async () => {
  const user = userEvent.setup()
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-ant-test")
  await user.click(screen.getByRole("button", { name: /continue/i }))
  await waitFor(() => expect(setApiKey).toHaveBeenCalledWith("sk-ant-test"))
  expect(screen.getByText("step2Title")).toBeInTheDocument()
})

test("blank API key submission warns and does not advance", async () => {
  const user = userEvent.setup()
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await user.click(screen.getByRole("button", { name: /continue/i }))
  expect(toastError).toHaveBeenCalledWith("toastNeedKey")
  expect(setApiKey).not.toHaveBeenCalled()
})

test("API key save error is logged and toasted", async () => {
  setApiKey.mockRejectedValueOnce(new Error("nope"))
  const user = userEvent.setup()
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-test")
  await user.click(screen.getByRole("button", { name: /continue/i }))
  await waitFor(() => expect(logError).toHaveBeenCalled())
  expect(toastError).toHaveBeenCalledWith("nope")
})

test("character pick advances to tour step (not closes dialog)", async () => {
  const onPick = jest.fn()
  const onOpenChange = jest.fn()
  // Start from character step by simulating a successful API-key save
  render(<OnboardingDialog open={true} onOpenChange={onOpenChange} onPickCharacter={onPick} />)
  const user = userEvent.setup()
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-test")
  await user.click(screen.getByRole("button", { name: /continue/i }))
  await waitFor(() => expect(screen.getByText("step2Title")).toBeInTheDocument())
  await user.click(screen.getByText("Helper"))
  expect(onPick).toHaveBeenCalledWith(charactersRef.current[0])
  // Now on tour step — onOpenChange must NOT have fired yet
  expect(onOpenChange).not.toHaveBeenCalled()
  // TOUR_SLIDES leads with `sandbox` (the WASM sandbox onboarding card).
  await waitFor(() => {
    expect(screen.getByTestId("onboarding-tour-slide-sandbox")).toBeInTheDocument()
  })
})

test("tour Next navigates through all slides and Done closes + dismisses", async () => {
  const user = userEvent.setup()
  const onOpenChange = jest.fn()
  render(<OnboardingDialog open={true} onOpenChange={onOpenChange} onPickCharacter={jest.fn()} />)
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-test")
  await user.click(screen.getByRole("button", { name: /continue/i }))
  await waitFor(() => expect(screen.getByText("step2Title")).toBeInTheDocument())
  await user.click(screen.getByText("Helper"))
  await waitFor(() =>
    expect(screen.getByTestId("onboarding-tour-slide-sandbox")).toBeInTheDocument()
  )
  // 6 slides: sandbox → ocr → computerUse → connectors → mobile → twin.
  // 5 Next clicks lands on the final (twin) slide where Done is visible.
  for (let i = 0; i < 5; i++) {
    await user.click(screen.getByRole("button", { name: /tour\.next/i }))
  }
  await waitFor(() => expect(screen.getByTestId("onboarding-tour-slide-twin")).toBeInTheDocument())
  await user.click(screen.getByRole("button", { name: /tour\.done/i }))
  await waitFor(() => expect(dismissOnboarding).toHaveBeenCalled())
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test("tour Open settings deep-links and dismisses onboarding", async () => {
  const user = userEvent.setup()
  const onOpenChange = jest.fn()
  render(<OnboardingDialog open={true} onOpenChange={onOpenChange} onPickCharacter={jest.fn()} />)
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-test")
  await user.click(screen.getByRole("button", { name: /continue/i }))
  await waitFor(() => expect(screen.getByText("step2Title")).toBeInTheDocument())
  await user.click(screen.getByText("Helper"))
  await waitFor(() =>
    expect(screen.getByTestId("onboarding-tour-slide-sandbox")).toBeInTheDocument()
  )
  // Advance one slide so the OCR cta is rendered.
  await user.click(screen.getByRole("button", { name: /tour\.next/i }))
  await waitFor(() => expect(screen.getByTestId("onboarding-tour-slide-ocr")).toBeInTheDocument())
  await user.click(screen.getByRole("button", { name: /tour\.ocr\.cta/i }))
  await waitFor(() => expect(dismissOnboarding).toHaveBeenCalled())
  expect(routerPush).toHaveBeenCalledWith("/settings?section=ocr")
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test("Skip at provider step closes and dismisses onboarding", async () => {
  const user = userEvent.setup()
  const onOpenChange = jest.fn()
  render(<OnboardingDialog open={true} onOpenChange={onOpenChange} onPickCharacter={jest.fn()} />)
  await user.click(screen.getByRole("button", { name: /^skip$/i }))
  await waitFor(() => expect(dismissOnboarding).toHaveBeenCalled())
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

test("tour Previous steps back to the prior slide (reverse direction)", async () => {
  const user = userEvent.setup()
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-test")
  await user.click(screen.getByRole("button", { name: /continue/i }))
  await waitFor(() => expect(screen.getByText("step2Title")).toBeInTheDocument())
  await user.click(screen.getByText("Helper"))
  await waitFor(() =>
    expect(screen.getByTestId("onboarding-tour-slide-sandbox")).toBeInTheDocument()
  )
  // Previous is disabled on the first slide — advance, then go back.
  expect(screen.getByRole("button", { name: /tour\.previous/i })).toBeDisabled()
  await user.click(screen.getByRole("button", { name: /tour\.next/i }))
  await waitFor(() => expect(screen.getByTestId("onboarding-tour-slide-ocr")).toBeInTheDocument())
  await user.click(screen.getByRole("button", { name: /tour\.previous/i }))
  await waitFor(() =>
    expect(screen.getByTestId("onboarding-tour-slide-sandbox")).toBeInTheDocument()
  )
})

test("renders every step under reduced motion", async () => {
  mockUseReducedMotion.mockReturnValue(true)
  const user = userEvent.setup()
  render(<OnboardingDialog open={true} onOpenChange={jest.fn()} onPickCharacter={jest.fn()} />)
  // provider step (its grid is a reduced-motion stagger container)
  expect(screen.getByTestId("onboarding-provider-claude")).toBeInTheDocument()
  await user.type(screen.getByPlaceholderText("apiKeyPlaceholder"), "sk-test")
  await user.click(screen.getByRole("button", { name: /continue/i }))
  // character step
  await waitFor(() => expect(screen.getByText("Helper")).toBeInTheDocument())
  await user.click(screen.getByText("Helper"))
  // tour step
  await waitFor(() =>
    expect(screen.getByTestId("onboarding-tour-slide-sandbox")).toBeInTheDocument()
  )
})
