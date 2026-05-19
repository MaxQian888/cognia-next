/**
 * Tests for LocalProviderSetupWizard component
 */

import React from "react"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { LocalProviderSetupWizard } from "./local-provider-setup-wizard"

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: jest.fn().mockResolvedValue(undefined),
  },
})

// Mock local-providers config
jest.mock("@/lib/ai/providers/local-providers", () => ({
  LOCAL_PROVIDER_CONFIGS: {
    ollama: {
      id: "ollama",
      name: "Ollama",
      defaultPort: 11434,
      defaultBaseURL: "http://localhost:11434",
      modelsEndpoint: "/api/tags",
      healthEndpoint: "/api/version",
      supportsModelList: true,
      supportsEmbeddings: true,
      description: "Run models locally with easy model management",
      website: "https://ollama.ai",
    },
    lmstudio: {
      id: "lmstudio",
      name: "LM Studio",
      defaultPort: 1234,
      defaultBaseURL: "http://localhost:1234",
      modelsEndpoint: "/v1/models",
      healthEndpoint: "/v1/models",
      supportsModelList: true,
      supportsEmbeddings: true,
      description: "Desktop app for running local LLMs",
      website: "https://lmstudio.ai",
    },
  },
}))

// Mock local-provider-service
const mockGetStatus = jest.fn()
const mockCreateLocalProviderService = jest.fn()

jest.mock("@/lib/ai/providers/local-provider-service", () => ({
  getInstallInstructions: jest.fn((providerId: string) => ({
    title: `Install ${providerId === "ollama" ? "Ollama" : "LM Studio"}`,
    steps: ["Download the installer", "Run the installer", "Start the application"],
    downloadUrl:
      providerId === "ollama" ? "https://ollama.ai/download" : "https://lmstudio.ai/download",
    docsUrl: providerId === "ollama" ? "https://ollama.ai/docs" : "https://lmstudio.ai/docs",
  })),
  createLocalProviderService: () => mockCreateLocalProviderService(),
}))

describe("LocalProviderSetupWizard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCreateLocalProviderService.mockReturnValue({
      getStatus: mockGetStatus,
    })
    mockGetStatus.mockResolvedValue({
      connected: true,
      version: "0.1.0",
      models_count: 5,
    })
  })

  describe("Step 1: Download", () => {
    it("should render the download step initially", () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      expect(screen.getByText("Install Ollama")).toBeInTheDocument()
      expect(screen.getByText(/Download the installer/)).toBeInTheDocument()
    })

    it("should show download button with correct link", () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      const downloadLink = screen.getByRole("link", { name: /Download Ollama/i })
      expect(downloadLink).toHaveAttribute("href", "https://ollama.ai/download")
      expect(downloadLink).toHaveAttribute("target", "_blank")
    })

    it("should show progress indicator at step 1", () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      // Progress bar should be at 20% (1/5 steps)
      const progressBar = document.querySelector('[role="progressbar"]')
      expect(progressBar).toBeInTheDocument()
    })

    it("should navigate to install step when Next is clicked", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      const nextButton = screen.getByText(/next/i)
      fireEvent.click(nextButton)

      await waitFor(() => {
        expect(screen.getByText("Installation Steps")).toBeInTheDocument()
      })
    })
  })

  describe("Step 2: Install", () => {
    it("should show installation steps", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      // Navigate to install step
      fireEvent.click(screen.getByText(/next/i))

      await waitFor(() => {
        expect(screen.getByText("Installation Steps")).toBeInTheDocument()
        expect(screen.getByText("Download the installer")).toBeInTheDocument()
        expect(screen.getByText("Run the installer")).toBeInTheDocument()
        expect(screen.getByText("Start the application")).toBeInTheDocument()
      })
    })

    it("should show ollama serve command for ollama provider", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      fireEvent.click(screen.getByText(/next/i))

      await waitFor(() => {
        expect(screen.getByText("ollama serve")).toBeInTheDocument()
      })
    })

    it("should navigate back to download step", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      fireEvent.click(screen.getByText(/next/i))

      await waitFor(() => {
        expect(screen.getByText("Installation Steps")).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText(/back/i))

      await waitFor(() => {
        expect(screen.getByText("Install Ollama")).toBeInTheDocument()
      })
    })

    it("should navigate to configure step when Next is clicked", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      fireEvent.click(screen.getByText(/next/i)) // Go to install
      await waitFor(() => {
        expect(screen.getByText("Installation Steps")).toBeInTheDocument()
      })

      fireEvent.click(screen.getByText(/next/i)) // Go to configure

      await waitFor(() => {
        expect(screen.getByText("Configuration")).toBeInTheDocument()
      })
    })
  })

  describe("Step 3: Configure", () => {
    const navigateToConfigure = async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)
      fireEvent.click(screen.getByText(/next/i)) // Download -> Install
      await waitFor(() => expect(screen.getByText("Installation Steps")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i)) // Install -> Configure
      await waitFor(() => expect(screen.getByText("Configuration")).toBeInTheDocument())
    }

    it("should show server URL configuration", async () => {
      await navigateToConfigure()

      expect(screen.getByText("Server URL")).toBeInTheDocument()
      expect(screen.getByText("http://localhost:11434")).toBeInTheDocument()
    })

    it("should show default port", async () => {
      await navigateToConfigure()

      expect(screen.getByText(/Default port: 11434/)).toBeInTheDocument()
    })

    it("should show ollama pull command for ollama provider", async () => {
      await navigateToConfigure()

      expect(screen.getByText("ollama pull llama3.2")).toBeInTheDocument()
    })

    it("should show documentation link", async () => {
      await navigateToConfigure()

      // The link's accessible name comes from the resolved translation
      // (`providers.viewDocumentation` → "View documentation" in en.json).
      // Earlier the test mock echoed keys verbatim; now it resolves real
      // bundle entries via `jest.setup.ts`.
      const docsLink = screen.getByRole("link", { name: /View documentation/i })
      expect(docsLink).toHaveAttribute("href", "https://ollama.ai/docs")
    })

    it("should navigate to verify step when Next is clicked", async () => {
      await navigateToConfigure()

      fireEvent.click(screen.getByText(/next/i))

      await waitFor(() => {
        // Look for the heading specifically
        expect(screen.getByRole("heading", { name: /Verify Connection/i })).toBeInTheDocument()
      })
    })
  })

  describe("Step 4: Verify", () => {
    const navigateToVerify = async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)
      fireEvent.click(screen.getByText(/next/i)) // Download -> Install
      await waitFor(() => expect(screen.getByText("Installation Steps")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i)) // Install -> Configure
      await waitFor(() => expect(screen.getByText("Configuration")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i)) // Configure -> Verify
      // Look for the heading specifically since "Verify Connection" appears as both heading and button
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /Verify Connection/i })).toBeInTheDocument()
      )
    }

    it("should show verify connection button", async () => {
      await navigateToVerify()

      expect(screen.getByRole("button", { name: /Verify Connection/i })).toBeInTheDocument()
    })

    it("should verify connection successfully", async () => {
      await navigateToVerify()

      const verifyButton = screen.getByRole("button", { name: /Verify Connection/i })

      await act(async () => {
        fireEvent.click(verifyButton)
      })

      await waitFor(() => {
        expect(mockGetStatus).toHaveBeenCalled()
      })

      // Should show success and navigate to complete
      await waitFor(() => {
        expect(screen.getByText("Setup Complete!")).toBeInTheDocument()
      })
    })

    it("should show error when verification fails", async () => {
      mockGetStatus.mockResolvedValueOnce({
        connected: false,
        error: "Connection refused",
      })

      await navigateToVerify()

      const verifyButton = screen.getByRole("button", { name: /Verify Connection/i })

      await act(async () => {
        fireEvent.click(verifyButton)
      })

      await waitFor(() => {
        expect(screen.getByText("Connection refused")).toBeInTheDocument()
      })
    })

    it("should handle verification exception", async () => {
      mockGetStatus.mockRejectedValueOnce(new Error("Network error"))

      await navigateToVerify()

      const verifyButton = screen.getByRole("button", { name: /Verify Connection/i })

      await act(async () => {
        fireEvent.click(verifyButton)
      })

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument()
      })
    })

    it("should allow skipping verification", async () => {
      await navigateToVerify()

      const skipButton = screen.getByText(/skip for now|skipForNow/i)
      fireEvent.click(skipButton)

      await waitFor(() => {
        expect(screen.getByText("Setup Complete!")).toBeInTheDocument()
      })
    })

    it("should show Complete Setup button after successful verification", async () => {
      await navigateToVerify()

      const verifyButton = screen.getByRole("button", { name: /Verify Connection/i })

      await act(async () => {
        fireEvent.click(verifyButton)
      })

      await waitFor(() => {
        expect(screen.getByText("Setup Complete!")).toBeInTheDocument()
      })
    })
  })

  describe("Step 5: Complete", () => {
    it("should show completion message", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      // Navigate through all steps
      fireEvent.click(screen.getByText(/next/i)) // Download -> Install
      await waitFor(() => expect(screen.getByText("Installation Steps")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i)) // Install -> Configure
      await waitFor(() => expect(screen.getByText("Configuration")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i)) // Configure -> Verify
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /Verify Connection/i })).toBeInTheDocument()
      )
      fireEvent.click(screen.getByText(/skip for now|skipForNow/i)) // Verify -> Complete

      await waitFor(() => {
        expect(screen.getByText("Setup Complete!")).toBeInTheDocument()
        expect(screen.getByText("Ollama is ready to use")).toBeInTheDocument()
      })
    })

    it("should call onComplete when Get Started is clicked", async () => {
      const onComplete = jest.fn()
      render(<LocalProviderSetupWizard providerId="ollama" onComplete={onComplete} />)

      // Navigate to complete step
      fireEvent.click(screen.getByText(/next/i))
      await waitFor(() => expect(screen.getByText("Installation Steps")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i))
      await waitFor(() => expect(screen.getByText("Configuration")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i))
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /Verify Connection/i })).toBeInTheDocument()
      )
      fireEvent.click(screen.getByText(/skip for now|skipForNow/i))
      await waitFor(() => expect(screen.getByText("Setup Complete!")).toBeInTheDocument())

      const getStartedButton = screen.getByText(/get started|getStarted/i)
      fireEvent.click(getStartedButton)

      expect(onComplete).toHaveBeenCalled()
    })

    it("should show Connected badge after successful verification", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      // Navigate through steps with verification
      fireEvent.click(screen.getByText(/next/i))
      await waitFor(() => expect(screen.getByText("Installation Steps")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i))
      await waitFor(() => expect(screen.getByText("Configuration")).toBeInTheDocument())
      fireEvent.click(screen.getByText(/next/i))
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: /Verify Connection/i })).toBeInTheDocument()
      )

      const verifyButton = screen.getByRole("button", { name: /Verify Connection/i })
      await act(async () => {
        fireEvent.click(verifyButton)
      })

      await waitFor(() => {
        expect(screen.getByText("Setup Complete!")).toBeInTheDocument()
        expect(screen.getByText("Connected")).toBeInTheDocument()
      })
    })
  })

  describe("Copy Command", () => {
    it("should copy command to clipboard when copy button is clicked", async () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      fireEvent.click(screen.getByText(/next/i)) // Go to install

      await waitFor(() => {
        expect(screen.getByText("ollama serve")).toBeInTheDocument()
      })

      // Find the copy button near the command
      const copyButtons = screen.getAllByRole("button")
      const copyButton = copyButtons.find((btn) => btn.querySelector("svg"))

      if (copyButton) {
        await act(async () => {
          fireEvent.click(copyButton)
        })

        await waitFor(() => {
          expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ollama serve")
        })
      }
    })

    it("should handle clipboard error gracefully", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation()
      ;(navigator.clipboard.writeText as jest.Mock).mockRejectedValueOnce(
        new Error("Clipboard error")
      )

      render(<LocalProviderSetupWizard providerId="ollama" />)

      fireEvent.click(screen.getByText(/next/i))

      await waitFor(() => {
        expect(screen.getByText("ollama serve")).toBeInTheDocument()
      })

      const copyButtons = screen.getAllByRole("button")
      const copyButton = copyButtons.find((btn) => btn.querySelector("svg"))

      if (copyButton) {
        await act(async () => {
          fireEvent.click(copyButton)
        })

        await waitFor(() => {
          expect(consoleSpy).toHaveBeenCalled()
          expect(String(consoleSpy.mock.calls.at(-1)?.[0] ?? "")).toContain(
            "Failed to copy command"
          )
        })
      }

      consoleSpy.mockRestore()
    })
  })

  describe("Different Providers", () => {
    it("should show LM Studio configuration for lmstudio provider", async () => {
      render(<LocalProviderSetupWizard providerId="lmstudio" />)

      expect(screen.getByText("Install LM Studio")).toBeInTheDocument()

      const downloadLink = screen.getByRole("link", { name: /Download LM Studio/i })
      expect(downloadLink).toHaveAttribute("href", "https://lmstudio.ai/download")
    })
  })

  describe("Step Indicators", () => {
    it("should show all step indicators", () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      expect(screen.getByText("Download")).toBeInTheDocument()
      expect(screen.getByText("Install")).toBeInTheDocument()
      expect(screen.getByText("Configure")).toBeInTheDocument()
      expect(screen.getByText("Verify")).toBeInTheDocument()
      expect(screen.getByText("Complete")).toBeInTheDocument()
    })

    it("should highlight current step", () => {
      render(<LocalProviderSetupWizard providerId="ollama" />)

      // Download step should be highlighted (first step)
      const downloadStep = screen.getByText("Download").closest("div")
      expect(downloadStep).toHaveClass("text-primary")
    })
  })
})
