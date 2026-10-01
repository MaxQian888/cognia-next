/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const plugins = [
  { id: "pdf", name: "PDF", version: "1.2.0", enabled: true, source: "local", row: {} },
  { id: "office", name: "Office", version: "2.0.0", enabled: false, source: "local", row: {} },
  { id: "core", name: "Core", version: "1.0.0", enabled: true, source: "builtin", row: {} },
]
jest.mock("@/hooks/plugins/use-cogsets", () => ({
  useInstalledPluginSummaries: () => ({ plugins, byId: new Map(), loading: false }),
}))
const createCogsetFromPlugins = jest.fn(async (input: { pluginIds: string[] }) => ({
  id: "new",
  name: "n",
  members: input.pluginIds.map((pluginId) => ({ pluginId })),
  source: { kind: "manual" },
}))
const editCogset = jest.fn(async (_id: string, patch: Record<string, unknown>) => ({
  id: "x",
  name: "Saved",
  source: { kind: "manual" },
  ...patch,
}))
jest.mock("@/lib/plugin/cogset/actions", () => ({
  createCogsetFromPlugins: (input: { pluginIds: string[] }) => createCogsetFromPlugins(input),
  editCogset: (id: string, patch: Record<string, unknown>) => editCogset(id, patch),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { CogsetEditorDialog } from "./cogset-editor-dialog"

const displayName = (c: Pick<CogsetRow, "name">) => c.name

beforeEach(() => jest.clearAllMocks())

describe("CogsetEditorDialog", () => {
  it("requires a name", () => {
    render(
      <CogsetEditorDialog
        mode={{ kind: "create" }}
        onOpenChange={jest.fn()}
        displayName={displayName}
        alwaysOn={[]}
      />
    )
    fireEvent.click(screen.getByTestId("cogset-editor-save"))
    expect(screen.getByRole("alert").textContent).toBe("nameRequired")
    expect(createCogsetFromPlugins).not.toHaveBeenCalled()
  })

  it("creates a cogset from checked plugins with optional and pinned members", async () => {
    const onOpenChange = jest.fn()
    render(
      <CogsetEditorDialog
        mode={{ kind: "create" }}
        onOpenChange={onOpenChange}
        displayName={displayName}
        alwaysOn={["core"]}
      />
    )
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Writing" } })
    fireEvent.click(screen.getByLabelText(/PDF/))
    fireEvent.click(screen.getByText('pin:{"version":"1.2.0"}'))
    fireEvent.click(screen.getByLabelText(/Office/))
    fireEvent.click(screen.getAllByText("optional")[1])
    fireEvent.click(screen.getByTestId("cogset-editor-save"))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(createCogsetFromPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Writing", pluginIds: ["pdf", "office"] })
    )
    expect(editCogset).toHaveBeenCalledWith("new", {
      members: [
        { pluginId: "pdf", expectedVersion: "1.2.0" },
        { pluginId: "office", optional: true },
      ],
    })
  })

  it("keeps an always-on plugin out of the selection", () => {
    render(
      <CogsetEditorDialog
        mode={{ kind: "create" }}
        onOpenChange={jest.fn()}
        displayName={displayName}
        alwaysOn={["core"]}
      />
    )
    expect((screen.getByLabelText(/Core/) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("alwaysOnBadge")).toBeTruthy()
  })

  it("filters by search", () => {
    render(
      <CogsetEditorDialog
        mode={{ kind: "create" }}
        onOpenChange={jest.fn()}
        displayName={displayName}
        alwaysOn={[]}
      />
    )
    fireEvent.change(screen.getByLabelText("plugins"), { target: { value: "off" } })
    expect(screen.queryByText("PDF")).toBeNull()
    fireEvent.change(screen.getByLabelText("plugins"), { target: { value: "zzz" } })
    expect(screen.getByText("noResults")).toBeTruthy()
  })

  it("preselects running plugins when saving the current set", async () => {
    render(
      <CogsetEditorDialog
        mode={{ kind: "save-current" }}
        onOpenChange={jest.fn()}
        displayName={displayName}
        alwaysOn={["core"]}
      />
    )
    await waitFor(() => expect(screen.getByText('selectedCount:{"count":1}')).toBeTruthy())
  })

  it("edits a cogset, keeping each member's config", async () => {
    const cogset: CogsetRow = {
      id: "x",
      name: "Old",
      members: [{ pluginId: "pdf", config: { dpi: 300 }, expectedVersion: "1.0.0" }],
      source: { kind: "manual" },
      createdAt: 1,
      updatedAt: 1,
    }
    render(
      <CogsetEditorDialog
        mode={{ kind: "edit", cogset }}
        onOpenChange={jest.fn()}
        displayName={displayName}
        alwaysOn={[]}
      />
    )
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "New name" } })
    fireEvent.click(screen.getByTestId("cogset-editor-save"))
    await waitFor(() => expect(editCogset).toHaveBeenCalled())
    expect(editCogset).toHaveBeenCalledWith("x", {
      name: "New name",
      description: "",
      // Re-pinned to the version installed now.
      members: [{ pluginId: "pdf", config: { dpi: 300 }, expectedVersion: "1.2.0" }],
    })
  })
})
