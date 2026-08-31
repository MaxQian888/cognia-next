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

const EMPTY_SCAN_RESULT = {
  runtimes: [] as { id: string; label: string; authenticated: boolean }[],
  migratable: [] as { vendor: string; installed: boolean; configPath?: string }[],
  capabilities: ["web"],
}
const scan = {
  phase: "empty",
  result: { ...EMPTY_SCAN_RESULT },
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

const createOnboardingRequest = jest.fn((input: Record<string, unknown>) => ({
  id: `onboarding:${input.sessionId}:${input.cardId}`,
}))
jest.mock("@/lib/onboarding/request", () => ({
  createOnboardingRequest: (input: Record<string, unknown>) => createOnboardingRequest(input),
}))
jest.mock("@/lib/onboarding/skill", () => ({
  onboardingSkillRowId: () => "skill_builtin_cognia_onboarding",
}))

const buildMigrationPreview = jest.fn().mockResolvedValue({ artifacts: {} })
const applyMigration = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/agent-migration/run", () => ({
  buildMigrationPreview: (...a: unknown[]) => buildMigrationPreview(...a),
  applyMigration: (...a: unknown[]) => applyMigration(...a),
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ setMobileRuntimeMode: jest.fn() }))

// The history walk is its own subsystem with its own suite; the flow only
// needs a settled count to build a plan from.
let historyTotal = 0
jest.mock("@/hooks/onboarding/use-history-import", () => ({
  useHistoryImport: () => ({
    phase: historyTotal > 0 ? "found" : "empty",
    total: historyTotal,
    sources: [],
    imported: 0,
    progress: 0,
    partial: false,
    importAll: jest.fn().mockResolvedValue(undefined),
  }),
}))

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
jest.mock("@/components/onboarding/express-sign-in", () => ({
  ExpressSignIn: () => <div data-testid="onboarding-express-sign-in" />,
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
  scan.result = { ...EMPTY_SCAN_RESULT }
  buildMigrationPreview.mockResolvedValue({ artifacts: {} })
  sessionCount = 0
  companionPaired = false
  companionLoading = false
  historyTotal = 0
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

  it("advances through the step-by-step sequence and persists each step", async () => {
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-customise"))
    // The path is persisted alongside the step, so a resumed setup does not
    // re-ask which one the user chose.
    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("scan", "custom"))
    expect(screen.getByTestId("onboarding-scan")).toBeInTheDocument()
  })

  it("takes the primary CTA to the recommended screen, not to the first step", async () => {
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-welcome-cta"))
    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("express", "express"))
    expect(screen.getByTestId("onboarding-express")).toBeInTheDocument()
    // Two screens end to end: the scan and sign-in steps are folded into this
    // one, not queued behind it.
    expect(screen.queryByTestId("onboarding-scan")).toBeNull()
  })

  it("offers no path at all until the fork is answered", () => {
    render(<OnboardingFlow />)
    // Welcome is the whole sequence until then, so there is nowhere to go back
    // to and nothing to continue to.
    expect(screen.queryByTestId("onboarding-back")).toBeNull()
    expect(screen.queryByTestId("onboarding-continue")).toBeNull()
  })

  it("resumes the recommended path from a persisted mode", () => {
    settings = {
      id: "singleton",
      onboardingProgress: {
        version: 2,
        path: "runtime_skipped",
        lastStep: "express",
        mode: "express",
      },
    } as AppSettings
    render(<OnboardingFlow />)
    expect(screen.getByTestId("onboarding-express")).toBeInTheDocument()
  })

  it("reads a pre-fork record as the step-by-step path", () => {
    // v1 rows carry no `mode`; a `lastStep` past the intro is the only
    // evidence of which path they were on, and only one path had those steps.
    settings = {
      id: "singleton",
      onboardingProgress: { version: 1, path: "runtime_skipped", lastStep: "scan" },
    } as AppSettings
    render(<OnboardingFlow />)
    expect(screen.getByTestId("onboarding-scan")).toBeInTheDocument()
  })

  it("runs only the plan lines the user left checked", async () => {
    scan.result = {
      runtimes: [{ id: "claude-code", label: "Claude Code", authenticated: true }],
      migratable: [{ vendor: "claude-code", installed: true, configPath: "~/.claude" }],
      capabilities: ["fs", "web"],
    } as typeof scan.result
    modelAccess.value = true
    modelAccess.resolved = true
    settings = {
      id: "singleton",
      onboardingProgress: {
        version: 2,
        path: "runtime_skipped",
        lastStep: "express",
        mode: "express",
      },
    } as AppSettings
    render(<OnboardingFlow />)

    // Drop the migration, then run.
    fireEvent.click(screen.getByTestId("onboarding-express-toggle-migrate-claude-code"))
    fireEvent.click(screen.getByTestId("onboarding-express-apply"))

    // Nothing was written: the only actionable line was unchecked, and the
    // remaining lines are statements of fact rather than work.
    await waitFor(() => expect(screen.getByTestId("onboarding-express-ready")).toBeInTheDocument())
    expect(applyMigration).not.toHaveBeenCalled()
    // And it hands over to the terminal step in place, rather than navigating.
    expect(screen.getByTestId("onboarding-card-summarize-web")).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it("blames the sign-in line when the recommended screen is abandoned", async () => {
    // The recommended screen carries the sign-in line, so bailing out of it is
    // the same omission the step-by-step path records as `provider_skipped` —
    // reporting a missing runtime would make the finish bar name the wrong thing.
    modelAccess.value = false
    modelAccess.resolved = false
    settings = {
      id: "singleton",
      onboardingProgress: {
        version: 2,
        path: "runtime_skipped",
        lastStep: "express",
        mode: "express",
      },
    } as AppSettings
    render(<OnboardingFlow />)
    fireEvent.click(screen.getByTestId("onboarding-skip"))
    await waitFor(() => expect(skipOnboarding).toHaveBeenCalledWith("provider_skipped", "express"))
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
    fireEvent.click(screen.getByTestId("onboarding-welcome-customise"))
    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("scan", "custom"))
    fireEvent.click(screen.getByTestId("onboarding-continue"))
    // scan → first-run, skipping provider.
    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("first-run", "custom"))
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

  it("runs a starter card through the production send path without settling before output", async () => {
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
    expect(createOnboardingRequest).toHaveBeenCalledWith({
      cardId: "summarize-web",
      sessionId: "s1",
      skillId: "skill_builtin_cognia_onboarding",
      prompt: "cards.summarizeWeb.prompt",
    })
    expect(queuePendingChatPrompt).toHaveBeenCalledWith("s1", "cards.summarizeWeb.prompt", {
      requestId: "onboarding:s1:summarize-web",
      skillIds: ["skill_builtin_cognia_onboarding"],
    })
    await waitFor(() =>
      expect(setOnboardingProfile).toHaveBeenCalledWith({
        intent: "summarize-web",
        characterId: "c1",
      })
    )
    expect(completeOnboarding).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("does not let the terminal step claim success with no model to run on", async () => {
    // Without the gate the step would create a durable request that cannot be
    // dispatched, then strand the user in the chat pane before any result.
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

    await waitFor(() => expect(advanceOnboarding).toHaveBeenCalledWith("first-run", "custom"))
    expect(screen.getByRole("heading", { name: "firstRun.title" })).toBeInTheDocument()
  })
})
