import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const importModelFromEntries = jest.fn()
jest.mock("./pet-model-import", () => ({
  importModelFromEntries: (...a: unknown[]) => importModelFromEntries(...a),
}))

const toastSuccess = jest.fn()
const toastWarning = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
  },
}))

import { PetModelImportDialog } from "./pet-model-import-dialog"
import type { DiscoveredModel } from "@/lib/pet/live2d/discover-models"

function model(partial: Partial<DiscoveredModel> & { key: string }): DiscoveredModel {
  return {
    name: partial.key,
    settingsPath: `${partial.key}/x.model3.json`,
    entries: [{ path: `${partial.key}/x.model3.json`, blob: new Blob(["{}"]) }],
    totalBytes: 1024,
    valid: true,
    ...partial,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  importModelFromEntries.mockResolvedValue({ ok: true, id: "pm_x" })
})

it("lists models and disables invalid rows with their reason", () => {
  render(
    <PetModelImportDialog
      open
      models={[
        model({ key: "A" }),
        model({ key: "B", valid: false, errorCode: "missingReferenced" }),
      ]}
      onOpenChange={jest.fn()}
      onImported={jest.fn()}
    />
  )
  expect(screen.getByRole("checkbox", { name: "A" })).toBeEnabled()
  expect(screen.getByRole("checkbox", { name: "B" })).toBeDisabled()
  expect(screen.getByText("The model is missing files it references.")).toBeInTheDocument()
})

it("disables the import button when nothing is selected", () => {
  render(
    <PetModelImportDialog
      open
      models={[model({ key: "A" })]}
      onOpenChange={jest.fn()}
      onImported={jest.fn()}
    />
  )
  expect(screen.getByRole("button", { name: "importButton" })).toBeDisabled()
})

it("select-all picks only valid models and imports each, then closes", async () => {
  const user = userEvent.setup()
  const onOpenChange = jest.fn()
  const onImported = jest.fn()
  render(
    <PetModelImportDialog
      open
      models={[
        model({ key: "A" }),
        model({ key: "B" }),
        model({ key: "C", valid: false, errorCode: "tooLarge" }),
      ]}
      onOpenChange={onOpenChange}
      onImported={onImported}
    />
  )
  await user.click(screen.getByRole("checkbox", { name: "selectAll" }))
  expect(screen.getByText("selectedCount")).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "importButton" }))
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  expect(importModelFromEntries).toHaveBeenCalledTimes(2)
  expect(onImported).toHaveBeenCalledWith("pm_x")
  expect(toastSuccess).toHaveBeenCalledWith("summary")
  expect(toastWarning).not.toHaveBeenCalled()
})

it("reports partial failures via a warning toast and a counted summary", async () => {
  const user = userEvent.setup()
  importModelFromEntries.mockResolvedValueOnce({ ok: false, code: "modelFailed" })
  render(
    <PetModelImportDialog
      open
      models={[model({ key: "A" }), model({ key: "B" })]}
      onOpenChange={jest.fn()}
      onImported={jest.fn()}
    />
  )
  await user.click(screen.getByRole("checkbox", { name: "selectAll" }))
  await user.click(screen.getByRole("button", { name: "importButton" }))
  await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("summary"))
  expect(toastWarning).toHaveBeenCalled()
})

it("toggles the whole selection off when select-all is clicked again", async () => {
  const user = userEvent.setup()
  render(
    <PetModelImportDialog
      open
      models={[model({ key: "A" }), model({ key: "B" })]}
      onOpenChange={jest.fn()}
      onImported={jest.fn()}
    />
  )
  await user.click(screen.getByRole("checkbox", { name: "selectAll" }))
  expect(screen.getByText("selectedCount")).toBeInTheDocument()
  await user.click(screen.getByRole("checkbox", { name: "selectAll" }))
  expect(screen.getByText("selectedCount")).toBeInTheDocument()
})

it("disables select-all and import when every model is invalid", () => {
  render(
    <PetModelImportDialog
      open
      models={[model({ key: "A", valid: false, errorCode: "invalidJson" })]}
      onOpenChange={jest.fn()}
      onImported={jest.fn()}
    />
  )
  expect(screen.getByRole("checkbox", { name: "selectAll" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "importButton" })).toBeDisabled()
})

it("closes without importing when cancelled", async () => {
  const user = userEvent.setup()
  const onOpenChange = jest.fn()
  render(
    <PetModelImportDialog
      open
      models={[model({ key: "A" })]}
      onOpenChange={onOpenChange}
      onImported={jest.fn()}
    />
  )
  await user.click(screen.getByRole("button", { name: "cancel" }))
  expect(onOpenChange).toHaveBeenCalledWith(false)
  expect(importModelFromEntries).not.toHaveBeenCalled()
})

it("imports just the toggled model when not selecting all", async () => {
  const user = userEvent.setup()
  const onImported = jest.fn()
  render(
    <PetModelImportDialog
      open
      models={[model({ key: "A" }), model({ key: "B" })]}
      onOpenChange={jest.fn()}
      onImported={onImported}
    />
  )
  await user.click(screen.getByRole("checkbox", { name: "B" }))
  expect(screen.getByText("selectedCount")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "importButton" }))
  await waitFor(() => expect(importModelFromEntries).toHaveBeenCalledTimes(1))
})
