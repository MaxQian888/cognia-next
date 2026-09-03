import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

jest.mock("@tauri-apps/plugin-dialog", () => ({
  open: jest.fn(),
}))

jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: jest.fn(() => true),
}))

jest.mock("@/lib/plugin/local/install-from-directory", () => ({
  previewLocalManifest: jest.fn(),
  installPluginFromDirectory: jest.fn(),
}))

jest.mock("@/lib/plugin/local/convert-local-source", () => ({
  inspectLocalPluginSource: jest.fn(),
}))

const mockPreInstall = jest.fn()
jest.mock("@/hooks/plugins/use-plugin-pre-install", () => ({
  usePluginPreInstall: () => ({
    target: null,
    install: mockPreInstall,
    resolveContinue: jest.fn(),
    resolveCancel: jest.fn(),
  }),
}))

const mockCreateLocalDirectoryClient = jest.fn((_sourceDir: string, _conversion?: unknown) => ({
  kind: "local-directory",
}))
jest.mock("@/lib/plugin/local/local-directory-client", () => ({
  createLocalDirectoryClient: (sourceDir: string, conversion?: unknown) =>
    mockCreateLocalDirectoryClient(sourceDir, conversion),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { canUseTauriInvoke } from "@/lib/native/utils"
import * as dialogPlugin from "@tauri-apps/plugin-dialog"
import {
  previewLocalManifest,
  installPluginFromDirectory,
} from "@/lib/plugin/local/install-from-directory"
import { inspectLocalPluginSource } from "@/lib/plugin/local/convert-local-source"
import { LoadUnpackedButton, useLoadUnpackedFlow } from "./load-unpacked-button"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sonner = require("sonner") as { toast: { success: jest.Mock; error: jest.Mock } }

const mockOpen = dialogPlugin.open as jest.MockedFunction<typeof dialogPlugin.open>
const mockCanUse = canUseTauriInvoke as jest.MockedFunction<typeof canUseTauriInvoke>
const mockPreview = previewLocalManifest as jest.MockedFunction<typeof previewLocalManifest>
const mockInspect = inspectLocalPluginSource as jest.MockedFunction<typeof inspectLocalPluginSource>

const MANIFEST = {
  id: "demo.plugin",
  name: "Demo Plugin",
  version: "1.2.3",
  type: "frontend",
} as never

/** A directory that is already a Cognia plugin: no conversion involved. */
const nativeInspection = () =>
  ({
    sourceFormat: "cognia" as const,
    report: { fidelity: "native-exact" as const, converted: [], warnings: [], blocking: [] },
    manifest: MANIFEST,
    generatedFiles: {},
    convertible: true,
    native: true,
  }) as never

/** A Claude Code bundle: convertible, so the dialog asks first. */
const foreignInspection = (convertible = true) =>
  ({
    sourceFormat: "claude-code" as const,
    report: {
      fidelity: convertible ? ("structured" as const) : ("unsupported" as const),
      converted: [],
      warnings: [
        {
          capability: "outputStyles",
          path: "output-styles/x.md",
          message: "Output styles are not a Cognia contribution.",
          blocking: false,
        },
      ],
      blocking: convertible
        ? []
        : [
            {
              capability: "hooks",
              path: "hooks/pre-tool-use.sh",
              message: "Command hooks have no Cognia equivalent.",
              blocking: true,
            },
          ],
    },
    manifest: convertible ? MANIFEST : undefined,
    generatedFiles: convertible ? { "plugin.json": '{"id":"demo.plugin"}' } : {},
    convertible,
    native: false,
  }) as never
const mockInstall = installPluginFromDirectory as jest.MockedFunction<
  typeof installPluginFromDirectory
>

function renderWithIntl(node: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockOpen.mockReset()
  mockCanUse.mockReset()
  mockCanUse.mockReturnValue(true)
  mockPreview.mockReset()
  mockInspect.mockReset()
  mockInstall.mockReset()
  mockPreInstall.mockReset()
  mockCreateLocalDirectoryClient.mockClear()
  sonner.toast.success.mockReset()
  sonner.toast.error.mockReset()
})

describe("LoadUnpackedButton", () => {
  it("renders the localized label", () => {
    renderWithIntl(<LoadUnpackedButton />)
    expect(
      screen.getByRole("button", { name: enMessages.plugins.loadUnpacked.label })
    ).toBeInTheDocument()
  })

  it("shows the tauri-required error and skips the picker on web", async () => {
    mockCanUse.mockReturnValue(false)
    renderWithIntl(<LoadUnpackedButton />)
    await userEvent.click(screen.getByTestId("load-unpacked-button"))
    expect(mockOpen).not.toHaveBeenCalled()
    expect(screen.getByText(enMessages.plugins.loadUnpacked.tauriRequiredError)).toBeInTheDocument()
  })

  it("noops silently when the user cancels the directory picker", async () => {
    mockOpen.mockResolvedValueOnce(null as never)
    renderWithIntl(<LoadUnpackedButton />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })
    expect(mockInspect).not.toHaveBeenCalled()
    expect(mockInstall).not.toHaveBeenCalled()
    expect(sonner.toast.success).not.toHaveBeenCalled()
  })

  it("surfaces a manifest preview failure as an inline error", async () => {
    mockOpen.mockResolvedValueOnce("C:/plugins/broken")
    mockInspect.mockRejectedValueOnce(new Error("invalid plugin.json"))
    const onInstalled = jest.fn()
    renderWithIntl(<LoadUnpackedButton onInstalled={onInstalled} />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("invalid plugin.json")
    expect(mockInstall).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
  })

  it("installs a provided dropped directory without reopening the picker", async () => {
    mockInspect.mockResolvedValueOnce(nativeInspection())
    mockPreInstall.mockResolvedValueOnce({ status: "installed", pluginId: "demo.plugin" })
    const onInstalled = jest.fn()

    function DroppedDirectoryHarness() {
      const flow = useLoadUnpackedFlow({ onInstalled })
      return <button onClick={() => void flow.trigger("/tmp/demo-plugin")}>Install dropped</button>
    }

    renderWithIntl(<DroppedDirectoryHarness />)
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Install dropped" }))
    })

    expect(mockOpen).not.toHaveBeenCalled()
    expect(mockInspect).toHaveBeenCalledWith("/tmp/demo-plugin")
    // A native directory carries no conversion, so the install path is
    // byte-for-byte what it was before conversion existed.
    expect(mockCreateLocalDirectoryClient).toHaveBeenCalledWith("/tmp/demo-plugin", undefined)
    expect(mockPreInstall).toHaveBeenCalledWith(
      "demo.plugin",
      "1.2.3",
      "Demo Plugin",
      expect.objectContaining({ kind: "local-directory" })
    )
    expect(onInstalled).toHaveBeenCalledWith("demo.plugin")
  })

  it("offers conversion for a foreign bundle instead of erroring out", async () => {
    // The whole gap. Picking a Claude Code plugin used to hit
    // `previewLocalManifest`, which reads <dir>/plugin.json only, and print a
    // raw error under the button with no hint that the identical bundle
    // installs fine from GitHub because that path converts it.
    mockOpen.mockResolvedValueOnce("/tmp/claude-plugin")
    mockInspect.mockResolvedValueOnce(foreignInspection())
    renderWithIntl(<LoadUnpackedButton />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })

    expect(screen.getByText("Convert this plugin?")).toBeInTheDocument()
    // The report is shown before the decision, not after it.
    expect(screen.getByText(/Output styles are not a Cognia contribution/)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
    // Nothing is installed until the user says so.
    expect(mockPreInstall).not.toHaveBeenCalled()
  })

  it("installs the converted result with its overlay once confirmed", async () => {
    mockOpen.mockResolvedValueOnce("/tmp/claude-plugin")
    mockInspect.mockResolvedValueOnce(foreignInspection())
    mockPreInstall.mockResolvedValueOnce({ status: "installed", pluginId: "demo.plugin" })
    const onInstalled = jest.fn()
    renderWithIntl(<LoadUnpackedButton onInstalled={onInstalled} />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })
    await act(async () => {
      await userEvent.click(screen.getByTestId("convert-and-install"))
    })

    expect(mockCreateLocalDirectoryClient).toHaveBeenCalledWith("/tmp/claude-plugin", {
      manifest: MANIFEST,
      generatedFiles: { "plugin.json": '{"id":"demo.plugin"}' },
    })
    // The pre-install chain gates on the CONVERTED manifest, which is the
    // plugin that actually lands on disk.
    expect(mockPreInstall).toHaveBeenCalledWith(
      "demo.plugin",
      "1.2.3",
      "Demo Plugin",
      expect.objectContaining({ kind: "local-directory" })
    )
    expect(onInstalled).toHaveBeenCalledWith("demo.plugin")
  })

  it("shows why an unconvertible bundle is blocked and refuses to install it", async () => {
    mockOpen.mockResolvedValueOnce("/tmp/claude-plugin")
    mockInspect.mockResolvedValueOnce(foreignInspection(false))
    renderWithIntl(<LoadUnpackedButton />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })

    // Which capability blocked it is the useful part, so the report stays.
    expect(screen.getByText(/Command hooks have no Cognia equivalent/)).toBeInTheDocument()
    expect(screen.getByTestId("conversion-blocked")).toBeInTheDocument()
    expect(screen.getByTestId("convert-and-install")).toBeDisabled()
  })

  it("installs nothing when the user backs out of the conversion", async () => {
    mockOpen.mockResolvedValueOnce("/tmp/claude-plugin")
    mockInspect.mockResolvedValueOnce(foreignInspection())
    renderWithIntl(<LoadUnpackedButton />)
    await act(async () => {
      await userEvent.click(screen.getByTestId("load-unpacked-button"))
    })
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    })

    expect(mockPreInstall).not.toHaveBeenCalled()
    expect(screen.queryByText("Convert this plugin?")).toBeNull()
  })
})
