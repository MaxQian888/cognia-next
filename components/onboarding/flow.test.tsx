/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { AppSettings } from "@cognia/agent-config-types"

const replace = jest.fn()
const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const detectPlatform = jest.fn(() => "tauri")
// Partial mock: `lib/tauri` picks its transport from `isTauri` / `isCapacitor`
// at import time, so replacing the whole module breaks the import graph.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  detectPlatform: () => detectPlatform(),
}))

const scan = {
  phase: "empty",
  result: { runtimes: [], migratable: [], capabilities: ["web"] },
  rescan: jest.fn(),
}
jest.mock("@/hooks/onboarding/use-machine-scan", () => ({ useMachineScan: () => scan }))

let companionPaired = false
let companionLoading = false
jest.mock("@/hooks/companion/use-companion-config", () => ({
  useCompanionConfig: () => ({
    config: companionPaired ? { deviceId: "device-1" } : null,
    paired: companionPaired,
    shortDeviceId: companionPaired ? "device-" : null,
    loading: companionLoading,
    reload: jest.fn(),
  }),
}))

// The flow issues two live queries: the character list and the session count.
// The mock tells them apart by their `initial` argument's shape.
let sessionCount = 0
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: (_q: unknown, _deps: unknown[], initial: unknown) =>
    typeof initial === "number" ? sessionCount : [{ id: "c1", name: "Ada" }],
}))

const createSession = jest.fn().mockResolvedValue({ id: "s1" })
jest.mock("@/lib/db/sessions", () => ({
  createSession: (...a: unknown[]) => createSession(...a),
  countSessions: jest.fn(),
}))
jest.mock("@/lib/db/characters", () => ({ listCharacters: jest.fn() }))

const queuePendingChatPrompt = jest.fn()
jest.mock("@/lib/chat/pending-prompt", () => ({
  queuePendingChatPrompt: (...a: unknown[]) => queuePendingChatPrompt(...a),
}))

jest.mock("@/lib/agent-migration/run", () => ({
  buildMigrationPreview: jest.fn(),
  applyMigration: jest.fn(),
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ setMobileRuntimeMode: jest.fn() }))

// The flow reads one verdict, not the credential stack behind it. Mocking the
// hook keeps this suite about sequencing — `use-model-access.test.tsx` owns
// the latch and the three sources it folds together.
const modelAccess = { value: false as boolean | null, resolved: false }
jest.mock("@/hooks/onboarding/use-model-access", () => ({
  useModelAccess: () => modelAccess,
}))
jest.mock("@/components/onboarding/steps/provider-step", () => ({
  // Stubbed down to the one thing the flow reacts to: which view is showing.
  ProviderStep: ({ onViewChange }: { onViewChange?: (v: "chooser" | "apiKey") => void }) => (
    <div data-testid="onboarding-provider">
      <button data-testid="stub-pick-api-key" onClick={() => onViewChange?.("apiKey")} />
      <button data-testid="stub-back-to-chooser" onClick={() => onViewChange?.("chooser")} />
    </div>
  ),
}))
jest.mock("@/components/desktop/avatar-badge", () => ({ AvatarBadge: () => <span /> }))

const advanceOnboarding = jest.fn().mockResolvedValue(undefined)
const completeOnboarding = jest.fn().mockResolvedValue(undefined)
const skipOnboarding = jest.fn().mockResolvedValue(undefined)
const setOnboardingProfile = jest.fn().mockResolvedValue(undefined)
let settings: AppSettings = { id: "singleton" } as AppSettings
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      settings,
      advanceOnboarding,
      completeOnboarding,
      skipOnboarding,
      setOnboardingProfile,
    }),
}))

import { OnboardingFlow } from "./flow"

beforeEach(() => {
  jest.clearAllMocks()
  createSession.mockResolvedValue({ id: "s1" })
  detectPlatform.mockReturnValue("tauri")
  settings = { id: "singleton" } as AppSettings
  sessionCount = 0
  companionPaired = false
  companionLoading = false
  modelAccess.value = false
  modelAccess.resolved = false
})

describe("OnboardingFlow", () => {
  it("starts on welcome for a fresh install", () => {
    render(<OnboardingFlow />)
    expect(screen.getByTestId("onboarding-welcome")).toBeInTheDocument()
    // A genuine first run has nothing to fall back to, so no "done this before".
    expect(screen.queryByTestId("onboarding-welcome-skip")).toBeNull()
  })

  it("lets a device that already has chats leave from welcome as completed", async () => {
    sessionCount = 3
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-skip"))
    // "I've done this before" is not a skip — nothing is missing, so the finish
    // bar must not nag; it records completion and goes home.
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalled())
    expect(skipOnboarding).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("advances through the desktop sequence and persists each step", async () => {
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-cta"))
    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("scan"))
    expect(screen.getByTestId("onboarding-scan")).toBeInTheDocument()
  })

  it("resumes a persisted step rather than restarting", () => {
    settings = {
      id: "singleton",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "provider" },
    } as AppSettings
    render(<OnboardingFlow />)
    expect(screen.getByTestId("onboarding-provider")).toBeInTheDocument()
  })

  it("drops the provider step entirely once model access already exists", async () => {
    modelAccess.value = true
    modelAccess.resolved = true
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-cta"))
    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("scan"))
    fireEvent.click(screen.getByTestId("onboarding-continue"))
    // scan → first-run, skipping provider.
    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("first-run"))
  })

  it("stands its action row down while the key panel owns the primary button", () => {
    settings = {
      id: "singleton",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "provider" },
    } as AppSettings
    render(<OnboardingFlow />)
    // Chooser view: Continue is the way past a step you do not want to do now.
    expect(screen.getByTestId("onboarding-continue")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("stub-pick-api-key"))
    // Key view: Save is the primary action, and a second button labelled
    // Continue beside it meant two ways off one screen with different results.
    expect(screen.queryByTestId("onboarding-continue")).toBeNull()
    // Leaving early still has to be possible from here.
    expect(screen.getByTestId("onboarding-skip")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("stub-back-to-chooser"))
    expect(screen.getByTestId("onboarding-continue")).toBeInTheDocument()
  })

  it("resets the provider view on a step change, so a return visit is not stuck", async () => {
    settings = {
      id: "singleton",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "provider" },
    } as AppSettings
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("stub-pick-api-key"))
    expect(screen.queryByTestId("onboarding-continue")).toBeNull()

    // Back to the scan step, then forward again: the step remounts at its
    // chooser, and the action row has to come back with it.
    fireEvent.click(screen.getByTestId("onboarding-back"))
    await waitFor(() => expect(screen.getByTestId("onboarding-scan")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("onboarding-continue"))
    await waitFor(() => expect(screen.getByTestId("onboarding-provider")).toBeInTheDocument())
    expect(screen.getByTestId("onboarding-continue")).toBeInTheDocument()
  })

  it("records why the user left so the finish bar can name it", async () => {
    settings = {
      id: "singleton",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "provider" },
    } as AppSettings
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-skip"))
    await waitFor(() => expect(skipOnboarding).toHaveBeenCalledWith("provider_skipped", "provider"))
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("runs a starter card through the production send path and completes", async () => {
    modelAccess.value = true
    modelAccess.resolved = true
    settings = {
      id: "singleton",
      apiKey: "sk-ant-x",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "first-run" },
    } as AppSettings
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-card-summarize-web"))

    await waitFor(() => expect(createSession).toHaveBeenCalled())
    // The prompt is queued for the chat pane rather than sent here, so the
    // first output goes through exactly the normal turn pipeline.
    expect(queuePendingChatPrompt).toHaveBeenCalledWith("s1", "cards.summarizeWeb.prompt")
    await waitFor(() =>
      expect(setOnboardingProfile).toHaveBeenCalledWith({
        intent: "summarize-web",
        characterId: "c1",
      })
    )
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalled())
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("does not let the terminal step claim success with no model to run on", async () => {
    // The cards create a session, queue a prompt and record the flow as
    // `completed`; without the gate the step reported success and handed the
    // user a turn that failed in the chat pane a moment later.
    modelAccess.value = false
    modelAccess.resolved = false
    settings = {
      id: "singleton",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "first-run" },
    } as AppSettings
    render(<OnboardingFlow />)
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeDisabled()

    // And it offers the way out rather than just refusing.
    fireEvent.click(screen.getByTestId("onboarding-first-run-connect"))
    await waitFor(() => expect(screen.getByTestId("onboarding-provider")).toBeInTheDocument())
  })

  it("unblocks the terminal step for a model connected during the flow", async () => {
    // The sequence verdict is latched so the steps cannot shuffle underneath
    // the user — but the card gate reads the live one, or someone who just
    // pasted a key would meet disabled cards one step later.
    modelAccess.value = false
    modelAccess.resolved = false
    settings = {
      id: "singleton",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "first-run" },
    } as AppSettings
    const { rerender } = render(<OnboardingFlow />)
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeDisabled()

    modelAccess.value = true
    rerender(<OnboardingFlow />)
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-card-summarize-web")).not.toBeDisabled()
    )
  })

  it("shows no Skip on welcome — there is nothing to abandon yet", () => {
    render(<OnboardingFlow />)
    expect(screen.queryByTestId("onboarding-skip")).toBeNull()
  })

  it("keeps a paired-mode phone on the pairing step until pairing is locally confirmed", () => {
    detectPlatform.mockReturnValue("mobile")
    settings = {
      id: "singleton",
      mobileRuntimeMode: "paired",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "first-run" },
    } as AppSettings

    render(<OnboardingFlow />)

    expect(screen.getByRole("heading", { name: "scan.pairedTitle" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "continue" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "scan.pairedCta" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "skip" })).toBeNull()
  })

  it("lets a locally confirmed paired phone continue to its first task", async () => {
    detectPlatform.mockReturnValue("mobile")
    companionPaired = true
    settings = {
      id: "singleton",
      mobileRuntimeMode: "paired",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "scan" },
    } as AppSettings

    render(<OnboardingFlow />)
    fireEvent.click(screen.getByRole("button", { name: "continue" }))

    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("first-run"))
    expect(screen.getByRole("heading", { name: "firstRun.title" })).toBeInTheDocument()
  })
})
