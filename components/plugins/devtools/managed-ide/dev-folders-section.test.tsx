/**
 * @jest-environment jsdom
 */

let mockFileChange: ((payload: { path: string }) => void) | undefined
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(async (_event: string, handler: typeof mockFileChange) => {
    mockFileChange = handler
    return () => undefined
  }),
}))
const mockPreview = jest.fn()
jest.mock("@/lib/plugin/local/install-from-directory", () => ({
  previewLocalManifest: (path: string) => mockPreview(path),
}))
const mockRegister = jest.fn(async () => ({ enabled: true, devPaths: [] }))
const mockUnregister = jest.fn(async () => ({ enabled: true, devPaths: [] }))
jest.mock("@/lib/plugin/ide/dev-mode", () => ({
  registerDevFolder: (...args: unknown[]) => mockRegister(...(args as [])),
  unregisterDevPath: (...args: unknown[]) => mockUnregister(...(args as [])),
}))
const mockTrigger = jest.fn(async () => undefined)
jest.mock("@/components/plugins/dialogs/load-unpacked-button", () => ({
  useLoadUnpackedFlow: () => ({ trigger: mockTrigger, busy: false, error: null, dialog: null }),
}))
const mockOpen = jest.fn()
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => mockOpen(...args) }))

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

import { DevFoldersSection } from "./dev-folders-section"

const validIde = { schemaVersion: 1, targets: ["pro-ide"] }
const manifest = (ide: unknown) => ({
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  type: "frontend",
  ide,
})

function renderSection(folders = [{ path: "/dev/acme", pluginId: "acme" }]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DevFoldersSection folders={folders} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPreview.mockResolvedValue(manifest(validIde))
})

it("checks each folder's manifest and says when it is valid", async () => {
  renderSection()
  await waitFor(() =>
    expect(screen.getByTestId("managed-ide-folder-acme")).toHaveTextContent("manifest.ide is valid")
  )
  expect(mockPreview).toHaveBeenCalledWith("/dev/acme")
})

it("re-checks live when a file under the folder changes, and only then", async () => {
  renderSection()
  await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1))
  mockPreview.mockResolvedValue(
    manifest({
      schemaVersion: 1,
      targets: ["pro-ide"],
      providers: [{ id: "x", kind: "nope", handler: "h" }],
    })
  )
  await act(async () => mockFileChange?.({ path: "/elsewhere/file.ts" }))
  expect(mockPreview).toHaveBeenCalledTimes(1)
  await act(async () => mockFileChange?.({ path: "/dev/acme/plugin.json" }))
  await waitFor(() =>
    expect(screen.getByTestId("managed-ide-folder-acme")).toHaveTextContent(/problem/)
  )
})

it("shows an unreadable plugin.json", async () => {
  mockPreview.mockRejectedValue(new Error("plugin.json not found"))
  renderSection()
  await waitFor(() =>
    expect(screen.getByTestId("managed-ide-folder-acme")).toHaveTextContent(
      "Could not read plugin.json: plugin.json not found"
    )
  )
})

it("registers a picked folder before installing it, so the install is trusted", async () => {
  mockOpen.mockResolvedValue("/dev/beta")
  mockPreview.mockResolvedValue({ ...manifest(validIde), id: "beta" })
  renderSection([])
  expect(screen.getByText("No plugin folder is registered.")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: "Add plugin folder" }))
  await waitFor(() => expect(mockTrigger).toHaveBeenCalledWith("/dev/beta"))
  expect(mockRegister).toHaveBeenCalledWith("/dev/beta", "beta")
  expect(mockRegister.mock.invocationCallOrder[0]).toBeLessThan(
    mockTrigger.mock.invocationCallOrder[0]
  )
})

it("removes a folder", async () => {
  renderSection()
  await userEvent.click(screen.getByRole("button", { name: "Remove /dev/acme" }))
  expect(mockUnregister).toHaveBeenCalledWith("/dev/acme")
})
