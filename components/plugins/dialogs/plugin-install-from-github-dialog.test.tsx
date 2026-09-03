import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { PluginInstallFromGithubDialog } from "./plugin-install-from-github-dialog"

// Heavy / orthogonal children — stubbed (each has its own test).
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))
jest.mock("../_shared/plugin-dependency-panel", () => ({
  PluginDependencyPanel: () => <div data-testid="dep-panel" />,
}))
jest.mock("@/lib/native/utils", () => ({ canUseTauriInvoke: () => true }))

const installMock = jest.fn()
jest.mock("@/hooks/plugins/use-plugin-pre-install", () => ({
  usePluginPreInstall: () => ({
    install: installMock,
    target: null,
    resolveContinue: jest.fn(),
    resolveCancel: jest.fn(),
    busy: false,
  }),
}))

const fetchPreviewMock = jest.fn()
const makeClientMock = jest.fn()
jest.mock("@/lib/plugin/package/github-source", () => ({
  ...jest.requireActual("@/lib/plugin/package/github-source"),
  fetchGithubPluginPreview: (...a: unknown[]) => fetchPreviewMock(...a),
  makeGithubMarketplaceClient: (...a: unknown[]) => makeClientMock(...a),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
const toastMessage = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    message: (...a: unknown[]) => toastMessage(...a),
  },
}))

const messages = {
  plugins: {
    githubDialog: {
      title: "Install from GitHub",
      description: "Paste a public repo reference.",
      label: "Repository",
      placeholder: "owner/repo",
      fetch: "Fetch",
      readme: "README",
      install: "Install",
      cancel: "Cancel",
      emptyError: "Enter a repository.",
      fetchError: "Fetch failed: {message}",
      desktopOnly: "Desktop only.",
      installSucceeded: "Installed {name}",
      installCancelled: "Install cancelled",
      installFailed: "Install failed: {message}",
      conversionTitle: "Automatic conversion",
      conversionSource: "Detected source: {source}",
      conversionCounts: "{converted} converted, {warnings} warnings",
      sourceCognia: "Cognia",
      sourceClaudeCode: "Claude Code",
      sourceCodex: "Codex",
      sourceGeminiCli: "Gemini CLI",
      fidelityNativeExact: "Native plugin; no conversion required.",
      fidelityStructured: "Structured conversion preserves supported declarations.",
      fidelityContextual: "Prompt behavior is preserved contextually.",
      fidelityUnsupported: "Unsupported behavior blocks installation.",
    },
    license: { label: "License", custom: "Custom", view: "View", hide: "Hide" },
  },
}

const PREVIEW = {
  manifest: {
    id: "demo.plugin",
    name: "Demo Plugin",
    version: "1.2.3",
    description: "A demo",
    type: "frontend",
    license: "MIT",
  },
  readme: "# Demo readme",
  license: "MIT License text",
  ref: { owner: "acme", repo: "demo" },
  sourceFormat: "cognia",
  conversionReport: {
    fidelity: "native-exact",
    converted: [],
    warnings: [],
    blocking: [],
  },
  generatedFiles: {},
}

function renderDialog(onOpenChange = jest.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PluginInstallFromGithubDialog open onOpenChange={onOpenChange} />
    </NextIntlClientProvider>
  )
  return onOpenChange
}

describe("PluginInstallFromGithubDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    makeClientMock.mockReturnValue({ getPlugin: jest.fn(), installPlugin: jest.fn() })
  })

  it("validates an empty repository input", () => {
    renderDialog()
    fireEvent.click(screen.getByText("Fetch"))
    expect(screen.getByRole("alert")).toHaveTextContent("Please enter a repository.")
  })

  it("fetches and renders the preview", async () => {
    fetchPreviewMock.mockResolvedValue(PREVIEW)
    renderDialog()
    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "acme/demo" } })
    fireEvent.click(screen.getByText("Fetch"))
    await waitFor(() => expect(screen.getByTestId("plugin-github-preview")).toBeInTheDocument())
    expect(screen.getByText("Demo Plugin")).toBeInTheDocument()
    expect(screen.getByText("v1.2.3")).toBeInTheDocument()
    expect(screen.getByTestId("md")).toHaveTextContent("Demo readme")
    expect(screen.getByTestId("plugin-conversion-report")).toHaveTextContent(
      "Native Cognia plugin; no conversion required."
    )
  })

  it("shows the detected foreign format and conversion fidelity", async () => {
    fetchPreviewMock.mockResolvedValue({
      ...PREVIEW,
      sourceFormat: "claude-code",
      conversionReport: {
        fidelity: "structured",
        converted: [
          {
            capability: "skills",
            path: "skills/review/SKILL.md",
            message: "converted",
            blocking: false,
          },
        ],
        warnings: [],
        blocking: [],
      },
    })
    renderDialog()
    fireEvent.change(screen.getByLabelText("GitHub repository"), {
      target: { value: "acme/demo" },
    })
    fireEvent.click(screen.getByText("Fetch"))
    await waitFor(() => expect(screen.getByTestId("plugin-conversion-report")).toBeInTheDocument())
    expect(screen.getByTestId("plugin-conversion-report")).toHaveTextContent(
      "Detected source: Claude Code"
    )
    expect(screen.getByTestId("plugin-conversion-report")).toHaveTextContent(
      "1 capability converted, no warnings, nothing blocking"
    )
  })

  it("surfaces a fetch error", async () => {
    fetchPreviewMock.mockRejectedValue(new Error("no plugin.json found"))
    renderDialog()
    fireEvent.change(screen.getByLabelText("GitHub repository"), {
      target: { value: "acme/empty" },
    })
    fireEvent.click(screen.getByText("Fetch"))
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load the plugin: no plugin.json found"
      )
    )
  })

  it("installs and closes on success", async () => {
    fetchPreviewMock.mockResolvedValue(PREVIEW)
    installMock.mockResolvedValue({ status: "installed", pluginId: "demo.plugin" })
    const onOpenChange = renderDialog()
    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "acme/demo" } })
    fireEvent.click(screen.getByText("Fetch"))
    await waitFor(() => expect(screen.getByTestId("plugin-github-preview")).toBeInTheDocument())

    fireEvent.click(screen.getByText("Install"))
    await waitFor(() =>
      expect(installMock).toHaveBeenCalledWith("demo.plugin", undefined, "Demo Plugin")
    )
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("toasts on install failure", async () => {
    fetchPreviewMock.mockResolvedValue(PREVIEW)
    installMock.mockResolvedValue({ status: "failed", stage: "install", message: "boom" })
    renderDialog()
    fireEvent.change(screen.getByLabelText("GitHub repository"), { target: { value: "acme/demo" } })
    fireEvent.click(screen.getByText("Fetch"))
    await waitFor(() => expect(screen.getByTestId("plugin-github-preview")).toBeInTheDocument())
    fireEvent.click(screen.getByText("Install"))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
  })
})
