/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const previewCogsetExport = jest.fn()
const exportCogsetPreview = jest.fn()
jest.mock("@/lib/plugin/cogpack/export", () => ({
  previewCogsetExport: (...a: unknown[]) => previewCogsetExport(...a),
  exportCogsetPreview: (...a: unknown[]) => exportCogsetPreview(...a),
  suggestCogpackId: (name: string) => name.toLowerCase().replace(/\s+/g, "-"),
}))
const saveBinaryFileAs = jest.fn(async (..._a: unknown[]) => true)
jest.mock("@/lib/files/file-bridge", () => ({
  saveBinaryFileAs: (...a: unknown[]) => saveBinaryFileAs(...a),
}))
let identity: unknown = { publicKey: "K" }
const createPublisherSigner = jest.fn(async () => ({
  publisher: "Ada",
  publicKey: "K",
  sign: jest.fn(),
}))
jest.mock("@/lib/templates/publisher-identity", () => ({
  getPublisherIdentity: async () => identity,
  createPublisherSigner: () => createPublisherSigner(),
}))
let tauri = true
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))
const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { CogpackExportDialog } from "./cogpack-export-dialog"

const cogset: CogsetRow = {
  id: "c",
  name: "Deep Writer",
  members: [],
  source: { kind: "manual" },
  createdAt: 1,
  updatedAt: 1,
}
const preview = {
  cogset,
  members: [
    {
      pluginId: "gh",
      name: "GH",
      version: "1.0.0",
      optional: false,
      source: {
        kind: "github",
        owner: "a",
        repo: "b",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
      config: { org: "acme" },
      secretFields: ["token"],
    },
    {
      pluginId: "notes",
      name: "Notes",
      version: "0.2.0",
      optional: true,
      source: { kind: "embedded" },
      secretFields: [],
      licenseText: "MIT",
    },
  ],
  missing: ["gone"],
  unportable: [{ pluginId: "vsx", name: "VSX", reason: "vscode-local" }],
  alwaysOnExcluded: ["core"],
}

function renderDialog() {
  const onOpenChange = jest.fn()
  render(
    <CogpackExportDialog
      cogset={cogset}
      onOpenChange={onOpenChange}
      displayName={(c) => c.name}
      pluginName={(id) => `n:${id}`}
    />
  )
  return onOpenChange
}

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
  identity = { publicKey: "K" }
  previewCogsetExport.mockResolvedValue(preview)
  exportCogsetPreview.mockResolvedValue({
    bytes: new Uint8Array([1]),
    manifest: { id: "deep-writer", version: "1.0.0" },
  })
})

describe("CogpackExportDialog", () => {
  it("shows what leaves the device and exports a signed file without the unchecked settings", async () => {
    const onOpenChange = renderDialog()
    await waitFor(() => expect(screen.getByTestId("cogpack-export-member-gh")).toBeTruthy())
    expect(screen.getByText('source.github:{"commit":"0123456"}')).toBeTruthy()
    expect(screen.getByText("embedded")).toBeTruthy()
    expect(screen.getByText('secretsLeftOut:{"fields":"token"}')).toBeTruthy()
    expect(screen.getByText("license")).toBeTruthy()
    expect(screen.getByText('missing:{"names":"n:gone"}')).toBeTruthy()
    expect(screen.getByText('unportable:{"names":"VSX"}')).toBeTruthy()
    expect(screen.getByText('alwaysOnExcluded:{"names":"n:core"}')).toBeTruthy()
    expect((screen.getByLabelText("id") as HTMLInputElement).value).toBe("deep-writer")

    fireEvent.click(screen.getByLabelText("includeSettings"))
    fireEvent.click(screen.getByTestId("cogpack-export-submit"))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const input = exportCogsetPreview.mock.calls[0][0]
    expect(input).toMatchObject({ id: "deep-writer", version: "1.0.0", name: "Deep Writer" })
    expect([...input.withoutConfig]).toEqual(["gh"])
    expect(input.signer).toBeDefined()
    expect(saveBinaryFileAs).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultName: "deep-writer-1.0.0.cogpack",
        bytes: new Uint8Array([1]),
        filters: [{ name: "fileFilter", extensions: ["cogpack"] }],
      })
    )
    expect(toastSuccess).toHaveBeenCalledWith('saved:{"file":"deep-writer-1.0.0.cogpack"}')
  })

  it("validates the id and version, and exports unsigned when asked", async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByLabelText("id")).toBeTruthy())
    fireEvent.change(screen.getByLabelText("id"), { target: { value: "bad id" } })
    fireEvent.change(screen.getByLabelText("version"), { target: { value: "1" } })
    fireEvent.click(screen.getByTestId("cogpack-export-submit"))
    expect(screen.getByText("invalidId")).toBeTruthy()
    expect(screen.getByText("invalidVersion")).toBeTruthy()
    expect(exportCogsetPreview).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("id"), { target: { value: "ok" } })
    fireEvent.change(screen.getByLabelText("version"), { target: { value: "2.0.0" } })
    fireEvent.click(screen.getByText("sign"))
    fireEvent.click(screen.getByTestId("cogpack-export-submit"))
    await waitFor(() => expect(exportCogsetPreview).toHaveBeenCalled())
    expect(exportCogsetPreview.mock.calls[0][0].signer).toBeUndefined()
    expect(createPublisherSigner).not.toHaveBeenCalled()
  })

  it("offers to create a key when there is none", async () => {
    identity = null
    renderDialog()
    await waitFor(() => expect(screen.getByText("signCreate")).toBeTruthy())
  })

  it("needs the desktop app to copy plugin files", async () => {
    tauri = false
    renderDialog()
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("needsDesktop"))
  })

  it("explains a cogset it cannot prepare, with the detail below", async () => {
    previewCogsetExport.mockRejectedValueOnce(new Error("Cogset d does not exist"))
    renderDialog()
    await waitFor(() => expect(screen.getByText("loadFailed")).toBeTruthy())
    expect(screen.getByText("Cogset d does not exist")).toBeTruthy()
  })

  it("toasts an export failure", async () => {
    exportCogsetPreview.mockRejectedValueOnce(new Error("too big"))
    renderDialog()
    await waitFor(() => expect(screen.getByTestId("cogpack-export-member-gh")).toBeTruthy())
    fireEvent.click(screen.getByTestId("cogpack-export-submit"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("failed", { description: "too big" })
    )
  })
})
