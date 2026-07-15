/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key} ${JSON.stringify(vars)}` : key,
}))

jest.mock("@/lib/plugin/vscode-shim/vsix-installer", () => ({
  installVsix: jest.fn(),
}))

jest.mock("@/lib/db/plugins", () => ({
  upsertPlugin: jest.fn().mockResolvedValue(undefined),
}))

const canUseTauriInvokeMock = jest.fn(() => false)
jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: () => canUseTauriInvokeMock(),
}))

jest.mock("@cognia/logging", () => ({
  loggers: { plugin: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } },
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { PluginVsixInstallDialog } from "./plugin-vsix-install-dialog"
import { installVsix } from "@/lib/plugin/vscode-shim/vsix-installer"
import { upsertPlugin } from "@/lib/db/plugins"

const installVsixMock = installVsix as jest.Mock
const upsertPluginMock = upsertPlugin as jest.Mock

function fakeParsedVsix() {
  return {
    pkgJson: {
      name: "rust-analyzer",
      displayName: "rust-analyzer",
      publisher: "rust-lang",
      version: "0.4.0",
      description: "Rust language server",
      permissions: ["fs:read", "shell:spawn"],
    },
    files: new Map(),
    sha256: "abcdef0123456789",
    themes: [],
    lspBinaryCandidates: [
      { path: "extension/server/rust-analyzer.exe", kind: "native-exe", sha256: "x" },
    ],
    bundleFormat: "cjs" as const,
  }
}

beforeEach(() => {
  installVsixMock.mockReset()
  upsertPluginMock.mockReset()
  canUseTauriInvokeMock.mockReturnValue(false)
})

afterEach(() => {
  jest.restoreAllMocks()
})

let realCreateElement: typeof document.createElement
let inputCreateCount = 0
function installFilePicker(fileBytes = new Uint8Array([1, 2, 3])) {
  realCreateElement = document.createElement.bind(document)
  inputCreateCount = 0
  jest.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "input") return realCreateElement(tag)
    inputCreateCount += 1
    const fakeFile = new File([fileBytes as unknown as BlobPart], "fake.vsix", {
      type: "application/octet-stream",
    })
    // Force arrayBuffer to resolve synchronously with the raw bytes so we
    // don't depend on jsdom's File.arrayBuffer (which may differ across
    // jsdom versions). The dialog reads `file.arrayBuffer()` once.
    Object.defineProperty(fakeFile, "arrayBuffer", {
      value: async () => fileBytes.buffer.slice(0),
      configurable: true,
    })
    const fake: Record<string, unknown> = {
      type: "",
      accept: "",
      files: [fakeFile],
      onchange: null,
      oncancel: null,
      click() {
        const self = this as { onchange?: (() => void) | null }
        self.onchange?.()
      },
    }
    return fake as unknown as HTMLInputElement
  }) as typeof document.createElement)
}

describe("PluginVsixInstallDialog", () => {
  it("opens with a Choose button when idle", () => {
    render(<PluginVsixInstallDialog open onOpenChange={jest.fn()} />)
    expect(screen.getByText("choose")).toBeInTheDocument()
  })

  it("parses a picked .vsix and renders the review body", async () => {
    installVsixMock.mockResolvedValueOnce(fakeParsedVsix())
    installFilePicker()
    render(<PluginVsixInstallDialog open onOpenChange={jest.fn()} />)
    fireEvent.click(screen.getByText("choose"))
    // Give the picker promise + arrayBuffer + installVsix microtasks time
    // to resolve before asserting on rendered output.
    await waitFor(() => expect(inputCreateCount).toBeGreaterThan(0), { timeout: 4000 })
    await waitFor(() => expect(installVsixMock).toHaveBeenCalled(), { timeout: 4000 })
    await waitFor(() => {
      expect(screen.getByText("rust-analyzer")).toBeInTheDocument()
      expect(screen.getByText("v0.4.0")).toBeInTheDocument()
      expect(screen.getByText("extension/server/rust-analyzer.exe")).toBeInTheDocument()
    })
  })

  it("renders an error card when installVsix throws", async () => {
    installVsixMock.mockRejectedValueOnce(new Error("invalid zip"))
    installFilePicker()
    render(<PluginVsixInstallDialog open onOpenChange={jest.fn()} />)
    fireEvent.click(screen.getByText("choose"))
    await waitFor(() => {
      expect(screen.getByText("parseError")).toBeInTheDocument()
      expect(screen.getByText("invalid zip")).toBeInTheDocument()
    })
  })

  it("upserts the plugin and closes the dialog on successful install", async () => {
    installVsixMock.mockResolvedValueOnce(fakeParsedVsix())
    const onOpenChange = jest.fn()
    installFilePicker()
    render(<PluginVsixInstallDialog open onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText("choose"))
    await waitFor(() => screen.getByText("rust-analyzer"))
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => {
      expect(upsertPluginMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "rust-lang.rust-analyzer",
          name: "rust-analyzer",
          version: "0.4.0",
          type: "vscode-extension",
          status: "discovered",
          enabled: false,
        })
      )
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })

  it("uses a vsix:// path stub when Tauri invoke is unavailable", async () => {
    canUseTauriInvokeMock.mockReturnValue(false)
    installVsixMock.mockResolvedValueOnce(fakeParsedVsix())
    installFilePicker()
    render(<PluginVsixInstallDialog open onOpenChange={jest.fn()} />)
    fireEvent.click(screen.getByText("choose"))
    await waitFor(() => screen.getByText("rust-analyzer"))
    fireEvent.click(screen.getByText("install"))
    await waitFor(() => {
      expect(upsertPluginMock).toHaveBeenCalledWith(
        expect.objectContaining({
          path: expect.stringMatching(/^vsix:\/\/rust-lang\.rust-analyzer@/),
        })
      )
    })
  })

  it("applies mobile-first w-[95vw] width to DialogContent", () => {
    render(<PluginVsixInstallDialog open onOpenChange={jest.fn()} />)
    const dialog = screen.getByRole("dialog")
    expect(dialog.className).toContain("w-[95vw]")
  })

  it("persists the adapted manifest, never the raw package.json", async () => {
    // Regression test for the dead install path: the dialog used to store
    // `result.pkgJson` verbatim, so `loadVscodeDefinition` threw on every
    // activate ("missing the vscodeExtension.identifier block"), and a hostile
    // manifest could self-declare a trusted publisher fingerprint.
    const parsed = fakeParsedVsix()
    installVsixMock.mockResolvedValueOnce(parsed)
    installFilePicker()
    render(<PluginVsixInstallDialog open onOpenChange={jest.fn()} />)
    fireEvent.click(screen.getByText("choose"))
    await waitFor(() => screen.getByText("rust-analyzer"))
    fireEvent.click(screen.getByText("install"))

    await waitFor(() => expect(upsertPluginMock).toHaveBeenCalled())
    const draft = upsertPluginMock.mock.calls[0][0]
    expect(draft.manifest).not.toBe(parsed.pkgJson)
    expect(draft.manifest.vscodeExtension.identifier).toBe("rust-lang.rust-analyzer")
    expect(draft.manifest.vscodeExtension.publisherKeyFingerprint).toBeUndefined()
    // The fixture's self-declared `pkgJson.permissions` must not survive.
    expect(draft.manifest.permissions).not.toContain("shell:spawn")
  })

  it("reviews inferred permissions rather than the manifest's self-declared ones", async () => {
    // The review body read `pkgJson.permissions` — a field VS Code manifests
    // don't have — so this section never rendered and every install looked
    // permission-free. It now renders the static-analysis result.
    installVsixMock.mockResolvedValueOnce(fakeParsedVsix())
    installFilePicker()
    render(<PluginVsixInstallDialog open onOpenChange={jest.fn()} />)
    fireEvent.click(screen.getByText("choose"))

    await waitFor(() => screen.getByText("sectionPermissions"))
    expect(screen.getByText("permissionsInferred")).toBeInTheDocument()
    // The fixture declares these; they are not inferred from its (empty) bundle.
    expect(screen.queryByText("shell:spawn")).not.toBeInTheDocument()
    expect(screen.queryByText("fs:read")).not.toBeInTheDocument()
  })
})
