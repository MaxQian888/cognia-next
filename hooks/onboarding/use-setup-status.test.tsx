/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"
import { ONBOARDING_STATE_VERSION, type OnboardingProgress } from "@cognia/agent-config-types"

const credentialStatus = { keyOk: false as boolean | null, plan: null as string | null }
jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: () => credentialStatus,
}))

const standaloneKind = { value: "unresolved" as "resolved" | "unresolved" }
jest.mock("@/lib/ai/chat/resolve-standalone-provider", () => ({
  resolveStandaloneProvider: () => ({ kind: standaloneKind.value }),
}))

const externalRuntimes = { workingCount: 0 }
jest.mock("@/components/settings/provider/use-external-runtime-connections", () => ({
  useExternalRuntimeConnections: () => externalRuntimes,
}))

const sessions = { count: 0 as number | undefined }
jest.mock("@/hooks/data", () => ({
  useClientLiveQuery: () => sessions.count,
}))
jest.mock("@/lib/db/sessions", () => ({ countSessions: jest.fn() }))

const settingsStoreState = {
  settings: { id: "singleton" } as {
    id: string
    apiKey?: string
    onboardingProgress?: OnboardingProgress
  },
  loaded: true,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: typeof settingsStoreState) => unknown) =>
    selector(settingsStoreState),
}))

import { useBuiltInModelAccess, useLiveModelAccess, useSetupStatus } from "./use-setup-status"

function Probe() {
  const status = useSetupStatus()
  const live = useLiveModelAccess()
  const builtIn = useBuiltInModelAccess()
  return <span data-testid="v">{JSON.stringify({ ...status, live, builtIn })}</span>
}

const read = () => JSON.parse(screen.getByTestId("v").textContent ?? "{}")

const skipped = (path: OnboardingProgress["path"]): OnboardingProgress => ({
  version: ONBOARDING_STATE_VERSION,
  path,
  skippedAt: "2026-09-01T00:00:00.000Z",
})

beforeEach(() => {
  credentialStatus.keyOk = false
  standaloneKind.value = "unresolved"
  externalRuntimes.workingCount = 0
  sessions.count = 0
  settingsStoreState.settings = { id: "singleton" }
  settingsStoreState.loaded = true
})

describe("useSetupStatus", () => {
  it("reports the missing model and the first task after a sign-in skip", () => {
    settingsStoreState.settings = {
      id: "singleton",
      onboardingProgress: skipped("provider_skipped"),
    }
    render(<Probe />)
    expect(read()).toMatchObject({ live: false, gaps: ["model", "first-task"] })
  })

  it("clears the model gap once a provider is configured in Settings", () => {
    settingsStoreState.settings = {
      id: "singleton",
      onboardingProgress: skipped("provider_skipped"),
    }
    standaloneKind.value = "resolved"
    render(<Probe />)
    expect(read()).toMatchObject({ live: true, gaps: ["first-task"] })
  })

  it("counts a connected external agent as access, but not as built-in access", () => {
    externalRuntimes.workingCount = 1
    render(<Probe />)
    expect(read()).toMatchObject({ live: true, builtIn: false, gaps: [] })
  })

  it("reads the legacy key slot too", () => {
    settingsStoreState.settings = { id: "singleton", apiKey: "sk-ant-x" }
    render(<Probe />)
    expect(read()).toMatchObject({ live: true, builtIn: true })
  })

  it("cannot say before settings hydrate, and raises no gap on that", () => {
    settingsStoreState.loaded = false
    settingsStoreState.settings = {
      id: "singleton",
      onboardingProgress: skipped("provider_skipped"),
    }
    sessions.count = 3
    render(<Probe />)
    expect(read()).toMatchObject({ live: null, builtIn: null, gaps: [] })
  })

  it("reports the gaps even after the bar was dismissed", () => {
    settingsStoreState.settings = {
      id: "singleton",
      onboardingProgress: { ...skipped("task_failed"), finishBarDismissed: true },
    }
    credentialStatus.keyOk = true
    render(<Probe />)
    expect(read()).toMatchObject({ gaps: ["task-failed"] })
  })

  it("treats a still-loading session count as unknown rather than zero", () => {
    settingsStoreState.settings = {
      id: "singleton",
      onboardingProgress: skipped("runtime_skipped"),
    }
    credentialStatus.keyOk = true
    sessions.count = undefined
    render(<Probe />)
    expect(read()).toMatchObject({ gaps: [] })
  })
})
