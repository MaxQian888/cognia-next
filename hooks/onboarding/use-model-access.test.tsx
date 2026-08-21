/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"

const credentialStatus = { keyOk: null as boolean | null, plan: null as string | null }
jest.mock("@/hooks/chat/use-credential-status", () => ({
  useCredentialStatus: () => credentialStatus,
}))

const standaloneKind = { value: "unresolved" as "resolved" | "unresolved" }
jest.mock("@/lib/ai/chat/resolve-standalone-provider", () => ({
  resolveStandaloneProvider: () => ({ kind: standaloneKind.value }),
}))

const settingsStoreState = {
  settings: { id: "singleton" } as unknown,
  loaded: true,
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (selector: (s: typeof settingsStoreState) => unknown) =>
    selector(settingsStoreState),
}))

import { useModelAccess } from "./use-model-access"
import { EMPTY_SCAN, type ScanResult } from "@/lib/onboarding/scan"

const runtime = { id: "claude-code", label: "Claude Code", authenticated: true }
const withRuntime: ScanResult = { ...EMPTY_SCAN, runtimes: [runtime] }

function Probe({ scan = EMPTY_SCAN }: { scan?: ScanResult }) {
  const access = useModelAccess(scan)
  return (
    <span data-testid="v">
      {String(access.value)}:{String(access.resolved)}
    </span>
  )
}

beforeEach(() => {
  credentialStatus.keyOk = null
  credentialStatus.plan = null
  standaloneKind.value = "unresolved"
  settingsStoreState.settings = { id: "singleton" }
  settingsStoreState.loaded = true
})

describe("useModelAccess", () => {
  it("stays unsettled while the credential probe is in flight", () => {
    render(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("null:false")
  })

  it("latches false once the probe answers with no credentials", () => {
    credentialStatus.keyOk = false
    render(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("false:false")
  })

  it("waits for settings hydration before latching a negative probe", () => {
    credentialStatus.keyOk = false
    settingsStoreState.loaded = false
    const { rerender } = render(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("null:false")

    act(() => {
      settingsStoreState.loaded = true
      standaloneKind.value = "resolved"
    })
    rerender(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("true:true")
  })

  it("latches true when the probe finds a credential", () => {
    credentialStatus.keyOk = true
    render(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("true:true")
  })

  it("settles on a settings-resolved provider even while the Tauri probe is null", () => {
    // A desktop user running entirely on OpenAI: `hasApiKey()` reads an
    // Anthropic-only slot and never answers for them.
    standaloneKind.value = "resolved"
    render(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("true:true")
  })

  it("settles on an already-authenticated runtime the scan found", () => {
    render(<Probe scan={withRuntime} />)
    expect(screen.getByTestId("v")).toHaveTextContent("true:true")
  })

  it("keeps the sequence latched but reports access gained mid-flow", () => {
    // The flip happens exactly when the user signs in on the sign-in step.
    // Re-sequencing there would drop the step they are standing on —
    // `nextStep` then returns the FIRST step, sending Continue back to the
    // start of the flow — so `resolved` stays put. But `value` has to move:
    // it gates the terminal step's cards, and someone who just pasted a key
    // must not meet disabled cards one step later.
    credentialStatus.keyOk = false
    const { rerender } = render(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("false:false")

    act(() => {
      credentialStatus.keyOk = true
    })
    rerender(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("true:false")
  })

  it("reports a provider configured by the sign-in step itself", () => {
    // The BYOK path writes `providerSettings`, which `keyOk` never reports on
    // a shell whose probe stays null.
    credentialStatus.keyOk = false
    const { rerender } = render(<Probe />)
    act(() => {
      standaloneKind.value = "resolved"
    })
    rerender(<Probe />)
    expect(screen.getByTestId("v")).toHaveTextContent("true:false")
  })
})
