/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { AddProviderWizard } from "./add-provider-wizard"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock Dialog components
jest.mock("@/components/ui/dialog")

// Mock Button
jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
  }) => (
    <button data-testid={`button-${variant || "default"}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

// Mock Input
jest.mock("@/components/ui/input")

// Mock Checkbox
jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
    id?: string
  }) => (
    <input
      type="checkbox"
      data-testid={`checkbox-${id || "default"}`}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      id={id}
    />
  ),
}))

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  Check: () => <span data-testid="icon-check" />,
  CheckCircle: () => <span data-testid="icon-check-circle" />,
  XCircle: () => <span data-testid="icon-x-circle" />,
  Loader2: () => <span data-testid="icon-loader" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
  Search: () => <span data-testid="icon-search" />,
  ExternalLink: () => <span data-testid="icon-external-link" />,
}))

describe("AddProviderWizard", () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    onComplete: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe("rendering", () => {
    it("renders dialog when open=true", () => {
      render(<AddProviderWizard {...defaultProps} />)
      expect(screen.getByTestId("dialog")).toBeInTheDocument()
    })

    it("does not render dialog when open=false", () => {
      render(<AddProviderWizard {...defaultProps} open={false} />)
      expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
    })

    it("renders dialog content when open", () => {
      render(<AddProviderWizard {...defaultProps} />)
      expect(screen.getByTestId("dialog-content")).toBeInTheDocument()
    })
  })

  describe("step 1 - provider selection", () => {
    it("shows step 1 provider grid by default", () => {
      render(<AddProviderWizard {...defaultProps} />)
      // Should show at least one provider
      expect(screen.getByText("OpenAI")).toBeInTheDocument()
    })

    it("shows all 8 providers in grid", () => {
      render(<AddProviderWizard {...defaultProps} />)
      expect(screen.getByText("OpenAI")).toBeInTheDocument()
      expect(screen.getByText("Anthropic")).toBeInTheDocument()
      expect(screen.getByText("Google")).toBeInTheDocument()
      expect(screen.getByText("DeepSeek")).toBeInTheDocument()
      expect(screen.getByText("Groq")).toBeInTheDocument()
      expect(screen.getByText("Mistral")).toBeInTheDocument()
      expect(screen.getByText("OpenRouter")).toBeInTheDocument()
      expect(screen.getByText("Ollama")).toBeInTheDocument()
    })

    it("shows a Custom option", () => {
      render(<AddProviderWizard {...defaultProps} />)
      expect(screen.getByText("Custom")).toBeInTheDocument()
    })

    it("shows step indicator with step 1 active", () => {
      render(<AddProviderWizard {...defaultProps} />)
      // Step indicator should show 4 steps
      expect(screen.getByTestId("step-indicator")).toBeInTheDocument()
    })

    it("shows search input on step 1", () => {
      render(<AddProviderWizard {...defaultProps} />)
      expect(screen.getByPlaceholderText("wizard.searchProviders")).toBeInTheDocument()
    })

    it("does not show Back button on step 1", () => {
      render(<AddProviderWizard {...defaultProps} />)
      expect(screen.queryByText("wizard.back")).not.toBeInTheDocument()
    })
  })

  describe("step navigation - selecting provider advances to step 2", () => {
    it("clicking a provider advances to step 2", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      // Should now be on step 2 — shows API key input
      expect(screen.getByTestId("api-key-input")).toBeInTheDocument()
    })

    it("step 2 shows configure credentials heading", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      expect(screen.getByText("wizard.configureCredentials")).toBeInTheDocument()
    })

    it("step 2 shows API key input", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("Anthropic"))
      expect(screen.getByTestId("api-key-input")).toBeInTheDocument()
    })

    it("step 2 shows Base URL input", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      expect(screen.getByTestId("base-url-input")).toBeInTheDocument()
    })

    it("step 2 shows Back button", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      expect(screen.getByText("wizard.back")).toBeInTheDocument()
    })

    it("Back button on step 2 returns to step 1", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      expect(screen.getByTestId("api-key-input")).toBeInTheDocument()
      fireEvent.click(screen.getByText("wizard.back"))
      expect(screen.getByText("OpenAI")).toBeInTheDocument()
      expect(screen.queryByTestId("api-key-input")).not.toBeInTheDocument()
    })

    it("Next button on step 2 advances to step 3", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      // Click next to go to step 3
      const nextBtn = screen.getByText("wizard.next")
      fireEvent.click(nextBtn)
      // Step 3 — model selection
      expect(screen.getByText("wizard.selectModels")).toBeInTheDocument()
    })
  })

  describe("step 3 - model selection", () => {
    it("shows model selection heading on step 3", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      fireEvent.click(screen.getByText("wizard.next"))
      expect(screen.getByText("wizard.selectModels")).toBeInTheDocument()
    })

    it("step 3 shows Back button", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      fireEvent.click(screen.getByText("wizard.next"))
      expect(screen.getByText("wizard.back")).toBeInTheDocument()
    })

    it("Back button on step 3 returns to step 2", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      fireEvent.click(screen.getByText("wizard.next"))
      fireEvent.click(screen.getByText("wizard.back"))
      expect(screen.getByTestId("api-key-input")).toBeInTheDocument()
    })

    it("step 3 shows Next button to advance to step 4", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      fireEvent.click(screen.getByText("wizard.next"))
      // models still loading — Next button disabled but present
      expect(screen.getByText("wizard.next")).toBeInTheDocument()
    })

    it("step 3 Next button advances to step 4 after models load", () => {
      render(<AddProviderWizard {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      fireEvent.click(screen.getByText("wizard.next"))
      // Fast-forward model loading timer
      act(() => {
        jest.runAllTimers()
      })
      fireEvent.click(screen.getByText("wizard.next"))
      expect(screen.getByText("wizard.testConnection")).toBeInTheDocument()
    })
  })

  describe("step 4 - test connection", () => {
    // Helper: navigate to step 4 (runs all timers to advance past loading states)
    const goToStep4 = () => {
      fireEvent.click(screen.getByText("OpenAI"))
      fireEvent.click(screen.getByText("wizard.next"))
      // advance model-loading timer so Next button becomes enabled
      act(() => {
        jest.runAllTimers()
      })
      fireEvent.click(screen.getByText("wizard.next"))
    }

    it("step 4 shows test connection heading", () => {
      render(<AddProviderWizard {...defaultProps} />)
      goToStep4()
      expect(screen.getByText("wizard.testConnection")).toBeInTheDocument()
    })

    it("step 4 shows Finish button", () => {
      render(<AddProviderWizard {...defaultProps} />)
      goToStep4()
      // Allow test simulation to complete
      act(() => {
        jest.runAllTimers()
      })
      expect(screen.getByText("wizard.finish")).toBeInTheDocument()
    })

    it("Finish button calls onComplete with config", () => {
      const onComplete = jest.fn()
      render(<AddProviderWizard {...defaultProps} onComplete={onComplete} />)
      goToStep4()
      act(() => {
        jest.runAllTimers()
      })
      fireEvent.click(screen.getByText("wizard.finish"))
      expect(onComplete).toHaveBeenCalledTimes(1)
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "openai",
          apiKey: expect.any(String),
          enabledModels: expect.any(Array),
          defaultModel: expect.any(String),
        })
      )
    })

    it("Back button on step 4 returns to step 3", () => {
      render(<AddProviderWizard {...defaultProps} />)
      goToStep4()
      act(() => {
        jest.runAllTimers()
      })
      fireEvent.click(screen.getByText("wizard.back"))
      expect(screen.getByText("wizard.selectModels")).toBeInTheDocument()
    })
  })

  describe("initialProviderId prop", () => {
    it("skips to step 2 when initialProviderId is provided", () => {
      render(<AddProviderWizard {...defaultProps} initialProviderId="anthropic" />)
      // Should start at step 2 since provider is pre-selected
      expect(screen.getByTestId("api-key-input")).toBeInTheDocument()
    })
  })

  describe("search filtering", () => {
    it("filters provider list when searching", () => {
      render(<AddProviderWizard {...defaultProps} />)
      const searchInput = screen.getByPlaceholderText("wizard.searchProviders")
      fireEvent.change(searchInput, { target: { value: "open" } })
      expect(screen.getByText("OpenAI")).toBeInTheDocument()
      expect(screen.getByText("OpenRouter")).toBeInTheDocument()
      // Anthropic should be hidden
      expect(screen.queryByText("Anthropic")).not.toBeInTheDocument()
    })
  })
})
