/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QuickAddProviderDialog, QUICK_ADD_PRESETS } from "./quick-add-provider-dialog"

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock stores
const mockAddCustomProvider = jest.fn()
jest.mock("@/stores", () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      addCustomProvider: mockAddCustomProvider,
    }
    return selector(state)
  },
}))

// Mock API test function
jest.mock("@/lib/ai/infrastructure/api-test", () => ({
  testCustomProviderConnectionByProtocol: jest.fn().mockResolvedValue({ success: true }),
}))

// Mock UI components
jest.mock("@/components/ui/button")

jest.mock("@/components/ui/input")

jest.mock("@/components/ui/label")

jest.mock("@/components/ui/badge")

jest.mock("@/components/ui/scroll-area")

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div data-testid="tabs">{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tabs-list">{children}</div>
  ),
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button data-testid={`tab-${value}`}>{children}</button>
  ),
}))

jest.mock("@/components/ui/dialog")

// Mock lucide-react icons
jest.mock("lucide-react", () => ({
  Check: () => <span data-testid="icon-check" />,
  ExternalLink: () => <span data-testid="icon-external" />,
  Eye: () => <span data-testid="icon-eye" />,
  EyeOff: () => <span data-testid="icon-eye-off" />,
  Zap: () => <span data-testid="icon-zap" />,
  Search: () => <span data-testid="icon-search" />,
}))

describe("QuickAddProviderDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("rendering", () => {
    it("renders when open", () => {
      render(<QuickAddProviderDialog {...defaultProps} />)
      expect(screen.getByTestId("dialog")).toBeInTheDocument()
    })

    it("does not render when closed", () => {
      render(<QuickAddProviderDialog {...defaultProps} open={false} />)
      expect(screen.queryByTestId("dialog")).not.toBeInTheDocument()
    })

    it("displays title with zap icon", () => {
      render(<QuickAddProviderDialog {...defaultProps} />)
      expect(screen.getByTestId("icon-zap")).toBeInTheDocument()
      expect(screen.getByText("quickAddProvider")).toBeInTheDocument()
    })

    it("displays search input", () => {
      render(<QuickAddProviderDialog {...defaultProps} />)
      expect(screen.getByTestId("icon-search")).toBeInTheDocument()
    })

    it("displays category tabs", () => {
      render(<QuickAddProviderDialog {...defaultProps} />)
      expect(screen.getByTestId("tab-all")).toBeInTheDocument()
      expect(screen.getByTestId("tab-china")).toBeInTheDocument()
      expect(screen.getByTestId("tab-global")).toBeInTheDocument()
      expect(screen.getByTestId("tab-proxy")).toBeInTheDocument()
    })

    it("displays provider presets", () => {
      render(<QuickAddProviderDialog {...defaultProps} />)
      // Should show some preset names
      expect(screen.getByText("SiliconFlow (硅基流动)")).toBeInTheDocument()
      expect(screen.getByText("Moonshot AI (月之暗面)")).toBeInTheDocument()
    })

    it("displays cancel button in footer", () => {
      render(<QuickAddProviderDialog {...defaultProps} />)
      expect(screen.getByText("cancel")).toBeInTheDocument()
    })
  })

  describe("preset selection", () => {
    it("shows API key input after selecting a preset", async () => {
      render(<QuickAddProviderDialog {...defaultProps} />)

      const presetButton = screen.getByText("SiliconFlow (硅基流动)")
      await userEvent.click(presetButton)

      expect(screen.getByText("apiKey")).toBeInTheDocument()
      expect(screen.getByText("getApiKey")).toBeInTheDocument()
    })

    it("marks quick-add API key input to avoid browser autofill collisions", async () => {
      render(<QuickAddProviderDialog {...defaultProps} />)

      await userEvent.click(screen.getByText("SiliconFlow (硅基流动)"))

      const apiKeyInput = screen
        .getAllByTestId("input")
        .find((input) => (input as HTMLInputElement).type === "password")
      expect(apiKeyInput).toHaveAttribute("autoComplete", "new-password")
      expect(apiKeyInput).toHaveAttribute("data-lpignore", "true")
      expect(apiKeyInput).toHaveAttribute("data-form-type", "other")
    })

    it("shows back button after selecting a preset", async () => {
      render(<QuickAddProviderDialog {...defaultProps} />)

      const presetButton = screen.getByText("SiliconFlow (硅基流动)")
      await userEvent.click(presetButton)

      expect(screen.getByText("back")).toBeInTheDocument()
    })

    it("shows save button after selecting a preset", async () => {
      render(<QuickAddProviderDialog {...defaultProps} />)

      const presetButton = screen.getByText("SiliconFlow (硅基流动)")
      await userEvent.click(presetButton)

      expect(screen.getByText("save")).toBeInTheDocument()
    })

    it("saves quick-add providers with catalog-backed model metadata", async () => {
      render(<QuickAddProviderDialog {...defaultProps} />)

      await userEvent.click(screen.getByText("SiliconFlow (硅基流动)"))
      await userEvent.type(screen.getByLabelText("apiKey"), "siliconflow-key")
      await userEvent.click(screen.getByText("save"))

      await waitFor(() => {
        expect(mockAddCustomProvider).toHaveBeenCalledWith(
          expect.objectContaining({
            customName: "SiliconFlow (硅基流动)",
            apiKey: "siliconflow-key",
            customModels: expect.arrayContaining(["deepseek-ai/DeepSeek-V3.2"]),
            customModelMetadata: expect.objectContaining({
              "deepseek-ai/DeepSeek-V3.2": expect.objectContaining({
                id: "deepseek-ai/DeepSeek-V3.2",
                name: "DeepSeek V3.2",
              }),
            }),
          })
        )
      })
    })
  })

  describe("QUICK_ADD_PRESETS", () => {
    it("contains expected providers", () => {
      const ids = QUICK_ADD_PRESETS.map((p) => p.id)
      expect(ids).toContain("siliconflow")
      expect(ids).toContain("moonshot")
      expect(ids).toContain("perplexity")
      expect(ids).toContain("deepinfra")
      expect(ids).not.toContain("zhipu")
      expect(ids).not.toContain("minimax")
    })

    it("all presets have required fields", () => {
      QUICK_ADD_PRESETS.forEach((preset) => {
        expect(preset.id).toBeTruthy()
        expect(preset.name).toBeTruthy()
        expect(preset.baseURL).toBeTruthy()
        expect(preset.apiProtocol).toBeTruthy()
        expect(preset.models.length).toBeGreaterThan(0)
        expect(preset.modelEntries.length).toBeGreaterThan(0)
        expect(preset.defaultModel).toBeTruthy()
        expect(["china", "global", "proxy"]).toContain(preset.category)
      })
    })

    it("default model is included in models list", () => {
      QUICK_ADD_PRESETS.forEach((preset) => {
        expect(preset.models).toContain(preset.defaultModel)
      })
    })
  })
})
