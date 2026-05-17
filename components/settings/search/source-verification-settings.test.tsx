import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"

const setVerifMock = jest.fn()

let settings: {
  sourceVerificationSettings?: {
    enabled: boolean
    mode: "ask" | "auto" | "disabled"
    minimumCredibilityScore: number
    autoFilterLowCredibility: boolean
    showVerificationBadges: boolean
    trustedDomains: string[]
    blockedDomains: string[]
    enableCrossValidation: boolean
  }
} = {}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(
    selector: (s: {
      settings: typeof settings
      setSourceVerificationSettings: typeof setVerifMock
    }) => T
  ) =>
    selector({
      settings,
      setSourceVerificationSettings: setVerifMock,
    }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const mockLogInfo = jest.fn()
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: (...args: unknown[]) => mockLogInfo(...args),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
  }),
}))

jest.mock("@/components/ui/slider", () => ({
  Slider: ({ value, onValueChange }: { value: number[]; onValueChange: (v: number[]) => void }) => (
    <input
      role="slider"
      type="number"
      aria-valuenow={value?.[0] ?? 0}
      value={value?.[0] ?? 0}
      onChange={(e) => onValueChange([Number(e.target.value)])}
    />
  ),
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <select
      data-testid="mode-select"
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectValue: () => null,
}))

// Shared stubs: components/ui/__mocks__/{collapsible,scroll-area}.tsx
jest.mock("@/components/ui/collapsible")
jest.mock("@/components/ui/scroll-area")

import { SourceVerificationSettings } from "./source-verification-settings"

function renderUI() {
  return render(
    <TooltipProvider>
      <SourceVerificationSettings />
    </TooltipProvider>
  )
}

beforeEach(() => {
  setVerifMock.mockReset()
  mockLogInfo.mockReset()
  settings = {}
})

describe("SourceVerificationSettings", () => {
  it("renders title", () => {
    renderUI()
    expect(screen.getByText("title")).toBeInTheDocument()
  })

  it("toggles enabled via switch", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: false,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: [],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    fireEvent.click(screen.getAllByRole("switch")[0])
    expect(setVerifMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it("changes mode via button-grid", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: true,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: [],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    fireEvent.click(screen.getByText("mode.auto"))
    expect(setVerifMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "auto" }))
  })

  it("adjusts minimum score via slider", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: true,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: [],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    fireEvent.change(screen.getByRole("slider"), { target: { value: 70 } })
    expect(setVerifMock).toHaveBeenCalledWith(
      expect.objectContaining({ minimumCredibilityScore: 0.7 })
    )
  })

  it("adds a trusted domain", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: true,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: [],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    const input = screen.getByPlaceholderText("trustedDomainPlaceholder")
    fireEvent.change(input, { target: { value: "https://www.example.com" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(setVerifMock).toHaveBeenCalledWith(
      expect.objectContaining({ trustedDomains: ["example.com"] })
    )
  })

  it("ignores duplicate trusted domain", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: true,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: ["example.com"],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    const input = screen.getByPlaceholderText("trustedDomainPlaceholder")
    fireEvent.change(input, { target: { value: "example.com" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(setVerifMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        trustedDomains: ["example.com", "example.com"],
      })
    )
  })

  it("adds a blocked domain", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: true,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: [],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    const input = screen.getByPlaceholderText("blockedDomainPlaceholder")
    fireEvent.change(input, { target: { value: "bad.com" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(setVerifMock).toHaveBeenCalledWith(
      expect.objectContaining({ blockedDomains: ["bad.com"] })
    )
  })

  it("logs trusted_domain_added with sanitized domain", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: true,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: [],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    const input = screen.getByPlaceholderText("trustedDomainPlaceholder")
    fireEvent.change(input, { target: { value: "https://www.example.com" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(mockLogInfo).toHaveBeenCalledWith("trusted_domain_added", { domain: "example.com" })
  })

  it("logs verification_enabled_changed when toggled", () => {
    settings = {
      sourceVerificationSettings: {
        enabled: false,
        mode: "ask",
        minimumCredibilityScore: 0.3,
        autoFilterLowCredibility: false,
        showVerificationBadges: true,
        trustedDomains: [],
        blockedDomains: [],
        enableCrossValidation: true,
      },
    }
    renderUI()
    fireEvent.click(screen.getAllByRole("switch")[0])
    expect(mockLogInfo).toHaveBeenCalledWith("verification_enabled_changed", { enabled: true })
  })
})
