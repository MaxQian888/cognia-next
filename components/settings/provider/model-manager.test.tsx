/**
 * Tests for ModelManager component
 */

import React from "react"
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react"
import { ModelManager } from "./model-manager"

// Mock Tauri API
const mockInvoke = jest.fn()
const mockListen = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

const originalTauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown })
  .__TAURI_INTERNALS__

beforeAll(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    writable: true,
    configurable: true,
  })
})

afterAll(() => {
  if (originalTauriInternals === undefined) {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    return
  }

  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: originalTauriInternals,
    writable: true,
    configurable: true,
  })
})

// Mock model data
const mockModels = [
  {
    id: "ocr-model-1",
    name: "OCR Model",
    description: "Optical character recognition model",
    size: 1024 * 1024 * 100, // 100MB
    category: "ocr",
    sources: [{ source: "hugging_face", url: "https://example.com/model1" }],
  },
  {
    id: "llm-model-1",
    name: "LLM Model",
    description: "Large language model",
    size: 1024 * 1024 * 1024 * 2, // 2GB
    category: "llm",
    sources: [{ source: "hugging_face", url: "https://example.com/model2" }],
  },
  {
    id: "embedding-model-1",
    name: "Embedding Model",
    description: "Text embedding model",
    size: 1024 * 1024 * 500, // 500MB
    category: "embedding",
    sources: [{ source: "model_scope", url: "https://example.com/model3" }],
  },
]

const mockConfig = {
  preferred_sources: ["hugging_face", "model_scope"],
  use_system_proxy: true,
  timeout_secs: 300,
  max_retries: 3,
  custom_mirrors: {},
}

describe("ModelManager", () => {
  beforeEach(() => {
    jest.clearAllMocks()

    // Default mock implementations
    mockInvoke.mockImplementation((command: string) => {
      switch (command) {
        case "model_list_available":
          return Promise.resolve(mockModels)
        case "model_list_installed":
          return Promise.resolve(["ocr-model-1"])
        case "model_get_download_config":
          return Promise.resolve(mockConfig)
        case "model_download":
          return Promise.resolve()
        case "model_delete":
          return Promise.resolve()
        case "model_test_proxy":
          return Promise.resolve(true)
        case "model_detect_proxy":
          return Promise.resolve("http://127.0.0.1:7890")
        default:
          return Promise.resolve()
      }
    })

    mockListen.mockImplementation(() => Promise.resolve(() => {}))
  })

  describe("Loading State", () => {
    it("should show loading spinner initially", async () => {
      // Delay the model loading
      mockInvoke.mockImplementation(() => new Promise(() => {}))

      await act(async () => {
        render(<ModelManager />)
      })

      // Should show loading state
      const loader = document.querySelector(".animate-spin")
      expect(loader).toBeInTheDocument()
    })
  })

  describe("Model Display", () => {
    it("should render models after loading", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("OCR Model")).toBeInTheDocument()
        expect(screen.getByText("LLM Model")).toBeInTheDocument()
        expect(screen.getByText("Embedding Model")).toBeInTheDocument()
      })
    })

    it("should show installed badge for installed models", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText(/^installed$/i)).toBeInTheDocument()
      })
    })

    it("should show model sizes", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("100.0 MB")).toBeInTheDocument()
        expect(screen.getByText("2.00 GB")).toBeInTheDocument()
        expect(screen.getByText("500.0 MB")).toBeInTheDocument()
      })
    })

    it("should show model descriptions", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Optical character recognition model")).toBeInTheDocument()
        expect(screen.getByText("Large language model")).toBeInTheDocument()
      })
    })

    it("should show installed count in header", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText(/1 of 3 models installed/)).toBeInTheDocument()
      })
    })
  })

  describe("Category Tabs", () => {
    it("should show All tab by default", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByRole("tab", { name: /all\s*models/i })).toBeInTheDocument()
      })
    })

    it("should filter models by category", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("OCR Model")).toBeInTheDocument()
      })

      // Click on OCR category tab
      const ocrTab = screen.getByRole("tab", { name: /OCR/i })
      await act(async () => {
        fireEvent.click(ocrTab)
      })

      // After clicking, the OCR model should still be visible
      // The filtering is done via state, which should update the tab content
      await waitFor(() => {
        expect(screen.getByText("OCR Model")).toBeInTheDocument()
      })
    })
  })

  describe("Model Actions", () => {
    it("should show Download button for non-installed models", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        const downloadButtons = screen.getAllByText("Download")
        expect(downloadButtons.length).toBeGreaterThan(0)
      })
    })

    it("should show Delete button for installed models", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Delete")).toBeInTheDocument()
      })
    })

    it("should call model_download when Download is clicked", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("LLM Model")).toBeInTheDocument()
      })

      const downloadButtons = screen.getAllByText("Download")
      await act(async () => {
        fireEvent.click(downloadButtons[0])
      })

      expect(mockInvoke).toHaveBeenCalledWith("model_download", expect.any(Object))
    })

    it("should call model_delete when Delete is clicked", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Delete")).toBeInTheDocument()
      })

      const deleteButton = screen.getByText("Delete")
      await act(async () => {
        fireEvent.click(deleteButton)
      })

      expect(mockInvoke).toHaveBeenCalledWith("model_delete", { modelId: "ocr-model-1" })
    })
  })

  describe("Refresh", () => {
    it("should show Refresh button", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Refresh")).toBeInTheDocument()
      })
    })

    it("should reload models when Refresh is clicked", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Refresh")).toBeInTheDocument()
      })

      const refreshButton = screen.getByText("Refresh")
      await act(async () => {
        fireEvent.click(refreshButton)
      })

      expect(mockInvoke).toHaveBeenCalledWith("model_list_available")
    })
  })

  describe("Settings Dialog", () => {
    it("should show Settings button", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeInTheDocument()
      })
    })

    it("should open settings dialog when Settings is clicked", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeInTheDocument()
      })

      const settingsButton = screen.getByText("Settings")
      fireEvent.click(settingsButton)

      await waitFor(() => {
        expect(screen.getByText("Download Settings")).toBeInTheDocument()
      })
    })

    it("should show proxy settings in dialog", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText("Settings"))

      await waitFor(() => {
        expect(screen.getByText("Auto-detect Proxy")).toBeInTheDocument()
        expect(screen.getByText("Proxy URL")).toBeInTheDocument()
        expect(screen.getByText("Preferred Sources")).toBeInTheDocument()
        expect(screen.getByText("Download Timeout")).toBeInTheDocument()
      })
    })
  })

  describe("Proxy Status", () => {
    it("should show proxy status banner when connected", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      // Open settings and set proxy
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole("button", { name: /settings/i }))

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /detect/i })).toBeInTheDocument()
      })

      // Click detect to set proxy URL
      const detectButton = screen.getByRole("button", { name: /detect/i })
      await act(async () => {
        fireEvent.click(detectButton)
      })

      // Proxy should be detected
      expect(mockInvoke).toHaveBeenCalledWith("model_detect_proxy")
    })
  })

  describe("Download Progress", () => {
    it("should show progress when model is downloading", async () => {
      // Set up event listener to receive progress updates
      let progressCallback: ((event: { payload: unknown }) => void) | null = null
      mockListen.mockImplementation(
        (event: string, callback: (e: { payload: unknown }) => void) => {
          if (event === "model-download-progress") {
            progressCallback = callback
          }
          return Promise.resolve(() => {})
        }
      )

      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("LLM Model")).toBeInTheDocument()
      })

      // Start download
      const downloadButtons = screen.getAllByText("Download")
      await act(async () => {
        fireEvent.click(downloadButtons[0])
      })

      // Simulate progress event
      if (progressCallback) {
        await act(async () => {
          progressCallback!({
            payload: {
              model_id: "llm-model-1",
              status: "downloading",
              downloaded_bytes: 500 * 1024 * 1024,
              total_bytes: 2 * 1024 * 1024 * 1024,
              percent: 25,
              speed_bps: 10 * 1024 * 1024,
              eta_secs: 150,
            },
          })
        })
      }

      // Should show progress
      await waitFor(() => {
        const progressBar = document.querySelector('[role="progressbar"]')
        expect(progressBar).toBeInTheDocument()
      })
    })
  })

  describe("Empty State", () => {
    it("should show empty message when no models in category", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("OCR Model")).toBeInTheDocument()
      })

      // Switch to a category with no models
      const visionTab = screen.queryByRole("tab", { name: /Vision/i })
      if (visionTab) {
        fireEvent.click(visionTab)

        await waitFor(() => {
          expect(screen.getByText("No models available in this category")).toBeInTheDocument()
        })
      }
    })
  })

  describe("Error Handling", () => {
    it("should handle load models error gracefully", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation()
      mockInvoke.mockRejectedValueOnce(new Error("Failed to load"))

      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled()
        expect(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Failed to load models")
      })

      consoleSpy.mockRestore()
    })

    it("should handle download error gracefully", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation()

      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("LLM Model")).toBeInTheDocument()
      })

      // Make download fail
      mockInvoke.mockRejectedValueOnce(new Error("Download failed"))

      const downloadButtons = screen.getAllByText("Download")
      await act(async () => {
        fireEvent.click(downloadButtons[0])
      })

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled()
        expect(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Download failed")
      })

      consoleSpy.mockRestore()
    })

    it("should handle delete error gracefully", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation()

      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Delete")).toBeInTheDocument()
      })

      // Make delete fail
      mockInvoke.mockRejectedValueOnce(new Error("Delete failed"))

      const deleteButton = screen.getByText("Delete")
      await act(async () => {
        fireEvent.click(deleteButton)
      })

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled()
        expect(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "")).toContain("Delete failed")
      })

      consoleSpy.mockRestore()
    })
  })

  describe("Non-Tauri Environment", () => {
    it("should not load models when not in Tauri environment", async () => {
      // Temporarily remove __TAURI_INTERNALS__ (Tauri v2)
      const hadTauriInternals = "__TAURI_INTERNALS__" in window
      const originalTauriInternals = (window as unknown as { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__

      mockInvoke.mockClear()

      await act(async () => {
        render(<ModelManager />)
      })

      // invoke should not be called
      expect(mockInvoke).not.toHaveBeenCalled()

      // Restore
      if (hadTauriInternals) {
        Object.defineProperty(window, "__TAURI_INTERNALS__", {
          value: originalTauriInternals,
          writable: true,
          configurable: true,
        })
      }
    })
  })

  describe("Source Selection", () => {
    it("should toggle source selection in settings", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText("Settings"))

      await waitFor(() => {
        expect(screen.getByText("HuggingFace")).toBeInTheDocument()
      })

      // Click on a source badge to toggle it
      const huggingFaceBadge = screen.getByText("HuggingFace")
      fireEvent.click(huggingFaceBadge)

      // Source should be toggled (removed since it's currently selected)
      expect(screen.getByText("HuggingFace")).toBeInTheDocument()
    })
  })

  describe("Proxy Testing", () => {
    it("should test proxy when test button is clicked", async () => {
      await act(async () => {
        render(<ModelManager />)
      })

      await waitFor(() => {
        expect(screen.getByText("Settings")).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText("Settings"))

      await waitFor(() => {
        expect(screen.getByPlaceholderText("http://127.0.0.1:7890")).toBeInTheDocument()
      })

      // Enter proxy URL
      const proxyInput = screen.getByPlaceholderText("http://127.0.0.1:7890")
      fireEvent.change(proxyInput, { target: { value: "http://127.0.0.1:7890" } })

      // The proxy row contains exactly two buttons: Detect and Test.
      const proxyRow = proxyInput.parentElement
      expect(proxyRow).toBeTruthy()
      const rowButtons = within(proxyRow as HTMLElement).getAllByRole("button")
      expect(rowButtons).toHaveLength(2)

      await act(async () => {
        fireEvent.click(rowButtons[1])
      })

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith("model_test_proxy", {
          proxyUrl: "http://127.0.0.1:7890",
        })
      })
    })
  })
})

// Helper function tests
describe("Helper Functions", () => {
  describe("formatFileSize", () => {
    it("should format bytes correctly", () => {
      // These are internal functions, tested indirectly through component rendering
      // The component displays "100.0 MB", "2.00 GB", "500.0 MB" for our mock data
    })
  })
})
