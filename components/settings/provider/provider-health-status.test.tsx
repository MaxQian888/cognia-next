/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen } from "@testing-library/react"
import { ProviderHealthStatus } from "./provider-health-status"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock API test
jest.mock("@/lib/ai/infrastructure/api-test", () => ({
  probeProviderConnection: jest.fn().mockResolvedValue({
    success: true,
    authoritative: true,
    outcome: "verified",
    latency_ms: 100,
    message: "Connected",
  }),
}))

// Mock stores
const mockUpdateProviderSettings = jest.fn()

jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      providerSettings: {
        openai: {
          apiKey: "test-key",
          healthStatus: "healthy",
          lastHealthCheck: Date.now(),
        },
        ollama: {
          baseURL: "http://localhost:11434",
          healthStatus: "unknown",
          lastHealthCheck: Date.now(),
        },
      },
      updateProviderSettings: mockUpdateProviderSettings,
    }
    return selector(state)
  },
}))

jest.mock("@/hooks/ai/use-provider-manager", () => ({
  useProviderHealth: jest.fn(() => ({
    circuitState: "closed",
    availability: { status: "available" },
    resetCircuit: jest.fn(),
  })),
}))

// Mock utils
jest.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
}))

// Mock UI components
jest.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value: number }) => <div data-testid="progress" data-value={value} />,
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
}))

jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe("ProviderHealthStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("renders without crashing", () => {
    const { container } = render(<ProviderHealthStatus providerId="openai" />)
    expect(container).toBeInTheDocument()
  })

  it("displays health status text", () => {
    render(<ProviderHealthStatus providerId="openai" />)
    expect(screen.getByText("healthStatus")).toBeInTheDocument()
  })

  it("renders in compact mode", () => {
    const { container } = render(<ProviderHealthStatus providerId="openai" compact />)
    expect(container).toBeInTheDocument()
  })

  it("displays status icon", () => {
    render(<ProviderHealthStatus providerId="openai" />)
    expect(screen.getByText("status.healthy")).toBeInTheDocument()
  })

  it("displays last check time", () => {
    render(<ProviderHealthStatus providerId="openai" />)
    expect(screen.getByText("justNow")).toBeInTheDocument()
  })

  it("keeps the manual check button enabled for keyless local providers", () => {
    render(<ProviderHealthStatus providerId="ollama" />)
    const buttons = screen.getAllByRole("button")
    expect(buttons[0]).not.toBeDisabled()
  })
})
