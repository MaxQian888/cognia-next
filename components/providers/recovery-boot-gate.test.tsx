/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { RecoveryBootGate } from "./recovery-boot-gate"

jest.mock("@/hooks/recovery/use-recovery-gate", () => ({ useRecoveryGate: jest.fn() }))
jest.mock("@/components/ui/loading-states", () => ({
  PageLoading: ({ variant, milestone }: { variant?: string; milestone?: string }) => (
    <div data-testid="page-loading" data-variant={variant} data-milestone={milestone} />
  ),
}))
jest.mock("@/components/recovery/safe-mode-shell", () => ({
  SafeModeShell: ({ probing }: { probing: boolean }) => (
    <div data-testid="safe-shell">{probing ? "probing" : "idle"}</div>
  ),
}))

const { useRecoveryGate } = jest.requireMock("@/hooks/recovery/use-recovery-gate") as {
  useRecoveryGate: jest.Mock
}

function gate(overrides: Record<string, unknown> = {}) {
  return {
    status: "normal",
    boot: null,
    state: null,
    probing: false,
    retry: jest.fn(),
    refresh: jest.fn(),
    ...overrides,
  }
}

describe("RecoveryBootGate", () => {
  beforeEach(() => jest.clearAllMocks())

  it("keeps the boot screen up, as its preferences step, while the decision is outstanding", () => {
    useRecoveryGate.mockReturnValue(gate({ status: "checking" }))
    render(
      <RecoveryBootGate>
        <div data-testid="app">app</div>
      </RecoveryBootGate>
    )
    // Not blank: the account gate was just showing this screen, and a blank
    // frame between it and the shell would be the flash this used to avoid.
    const loading = screen.getByTestId("page-loading")
    expect(loading).toHaveAttribute("data-variant", "workspace")
    expect(loading).toHaveAttribute("data-milestone", "preferences")
    expect(screen.queryByTestId("app")).not.toBeInTheDocument()
  })

  it("mounts the app when the controller allows a normal boot", () => {
    useRecoveryGate.mockReturnValue(gate())
    render(
      <RecoveryBootGate>
        <div data-testid="app">app</div>
      </RecoveryBootGate>
    )
    expect(screen.getByTestId("app")).toBeInTheDocument()
    expect(screen.queryByTestId("safe-shell")).not.toBeInTheDocument()
  })

  it("holds the app back and mounts the diagnostics shell in safe mode", () => {
    useRecoveryGate.mockReturnValue(gate({ status: "safe" }))
    render(
      <RecoveryBootGate>
        <div data-testid="app">app</div>
      </RecoveryBootGate>
    )
    expect(screen.getByTestId("safe-shell")).toBeInTheDocument()
    expect(screen.queryByTestId("app")).not.toBeInTheDocument()
  })

  it("passes the probing flag to the shell", () => {
    useRecoveryGate.mockReturnValue(gate({ status: "safe", probing: true }))
    render(
      <RecoveryBootGate>
        <div>app</div>
      </RecoveryBootGate>
    )
    expect(screen.getByTestId("safe-shell")).toHaveTextContent("probing")
  })
})
