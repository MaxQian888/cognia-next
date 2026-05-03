/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, fireEvent } from "@testing-library/react"
import { AddProviderPopover } from "./add-provider-popover"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock Popover components - control open state via trigger click
let popoverOpen = false
jest.mock("@/components/ui/popover", () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => {
    // Support controlled mode (open prop) or uncontrolled via state
    const isOpen = open !== undefined ? open : popoverOpen
    return (
      <div data-testid="popover" data-open={isOpen}>
        {React.Children.map(children, (child) => {
          if (React.isValidElement(child)) {
            return React.cloneElement(
              child as React.ReactElement<{ onOpenChange?: (open: boolean) => void }>,
              { onOpenChange }
            )
          }
          return child
        })}
      </div>
    )
  },
  PopoverTrigger: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => (
    <div
      data-testid="popover-trigger"
      onClick={() => {
        popoverOpen = !popoverOpen
        onOpenChange?.(!popoverOpen)
      }}
    >
      {children}
    </div>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    popoverOpen ? <div data-testid="popover-content">{children}</div> : null,
}))

// Mock Button
jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant,
    size,
    className,
    asChild,
    ...props
  }: {
    children: React.ReactNode
    onClick?: () => void
    variant?: string
    size?: string
    className?: string
    asChild?: boolean
  }) => {
    if (asChild) return <>{children}</>
    return (
      <button
        data-testid={`button-${variant || "default"}`}
        data-size={size || "default"}
        onClick={onClick}
        className={className}
        {...props}
      >
        {children}
      </button>
    )
  },
}))

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  Plus: () => <span data-testid="icon-plus" />,
  Wand2: () => <span data-testid="icon-wand2" />,
}))

describe("AddProviderPopover", () => {
  const defaultProps = {
    children: <button data-testid="trigger-btn">Add Provider</button>,
    onSelectProvider: jest.fn(),
    onCustomProvider: jest.fn(),
    onOpenWizard: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    popoverOpen = true // Keep popover open by default for content tests
  })

  afterEach(() => {
    popoverOpen = false
  })

  describe("rendering", () => {
    it("renders trigger child", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByTestId("trigger-btn")).toBeInTheDocument()
    })

    it("renders popover content when open", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByTestId("popover-content")).toBeInTheDocument()
    })

    it("shows Quick Add Provider title", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByText("quickAdd.title")).toBeInTheDocument()
    })

    it("shows all 8 provider options", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByText("OpenAI")).toBeInTheDocument()
      expect(screen.getByText("Anthropic")).toBeInTheDocument()
      expect(screen.getByText("Google")).toBeInTheDocument()
      expect(screen.getByText("DeepSeek")).toBeInTheDocument()
      expect(screen.getByText("Groq")).toBeInTheDocument()
      expect(screen.getByText("Mistral")).toBeInTheDocument()
      expect(screen.getByText("OpenRouter")).toBeInTheDocument()
      expect(screen.getByText("Ollama")).toBeInTheDocument()
    })

    it("shows provider descriptions", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByText("GPT-4o, GPT-4 Turbo")).toBeInTheDocument()
      expect(screen.getByText("Claude 3.5, Claude 3")).toBeInTheDocument()
    })

    it("shows provider icons (emoji)", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByText("🤖")).toBeInTheDocument()
      expect(screen.getByText("🧠")).toBeInTheDocument()
    })

    it("shows Add Custom Provider button", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByTestId("icon-plus")).toBeInTheDocument()
      expect(screen.getByText("quickAdd.customProvider")).toBeInTheDocument()
    })

    it("shows Advanced Wizard link", () => {
      render(<AddProviderPopover {...defaultProps} />)
      expect(screen.getByTestId("icon-wand2")).toBeInTheDocument()
      expect(screen.getByText("quickAdd.wizard")).toBeInTheDocument()
    })
  })

  describe("interactions", () => {
    it("calls onSelectProvider with correct ID when OpenAI is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenAI"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("openai")
    })

    it("calls onSelectProvider with correct ID when Anthropic is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("Anthropic"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("anthropic")
    })

    it("calls onSelectProvider with correct ID when Google is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("Google"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("google")
    })

    it("calls onSelectProvider with correct ID when DeepSeek is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("DeepSeek"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("deepseek")
    })

    it("calls onSelectProvider with correct ID when Groq is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("Groq"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("groq")
    })

    it("calls onSelectProvider with correct ID when Mistral is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("Mistral"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("mistral")
    })

    it("calls onSelectProvider with correct ID when OpenRouter is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("OpenRouter"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("openrouter")
    })

    it("calls onSelectProvider with correct ID when Ollama is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("Ollama"))
      expect(defaultProps.onSelectProvider).toHaveBeenCalledWith("ollama")
    })

    it("calls onCustomProvider when Add Custom Provider button is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("quickAdd.customProvider"))
      expect(defaultProps.onCustomProvider).toHaveBeenCalledTimes(1)
    })

    it("calls onOpenWizard when Advanced Wizard is clicked", () => {
      render(<AddProviderPopover {...defaultProps} />)
      fireEvent.click(screen.getByText("quickAdd.wizard"))
      expect(defaultProps.onOpenWizard).toHaveBeenCalledTimes(1)
    })
  })
})
