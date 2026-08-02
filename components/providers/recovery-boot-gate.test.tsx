/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react"

import { RecoveryBootGate } from "./recovery-boot-gate"

jest.mock("@/hooks/recovery/use-recovery-gate", () => ({ useRecoveryGate: jest.fn() }))
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

  it("renders nothing while the decision is outstanding", () => {
    useRecoveryGate.mockReturnValue(gate({ status: "checking" }))
    const { container } = render(
      <RecoveryBootGate>
        <div data-testid="app">app</div>
      </RecoveryBootGate>
    )
    expect(container).toBeEmptyDOMElement()
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
