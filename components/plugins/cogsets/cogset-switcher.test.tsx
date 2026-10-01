/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
const request = jest.fn()
const retry = jest.fn()
jest.mock("./use-cogset-switch", () => ({
  useCogsetSwitch: () => ({ request, retry, element: null }),
}))
jest.mock("./cogset-editor-dialog", () => ({
  CogsetEditorDialog: ({ mode }: { mode: { kind: string } | null }) =>
    mode ? <div data-testid="editor">{mode.kind}</div> : null,
}))
jest.mock("./cogset-manager-dialog", () => ({
  CogsetManagerDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="manager" /> : null,
}))
jest.mock("./cogset-delete-dialog", () => ({ CogsetDeleteDialog: () => null }))
const cogpackPick = jest.fn()
jest.mock("@/components/plugins/cogpacks/use-cogpack-import", () => ({
  useCogpackImport: () => ({ pick: cogpackPick, element: null }),
}))
jest.mock("@/components/plugins/cogpacks/cogpack-export-dialog", () => ({
  CogpackExportDialog: ({ cogset }: { cogset: { id: string } | null }) =>
    cogset ? <div data-testid="export-dialog">{cogset.id}</div> : null,
}))

import type { CogsetsView } from "@/hooks/plugins/use-cogsets"
import type { CogsetRow } from "@/types/plugin/plugin-cogset"

const writing: CogsetRow = {
  id: "w",
  name: "Writing",
  members: [{ pluginId: "a" }],
  source: { kind: "manual" },
  createdAt: 1,
  updatedAt: 1,
}
const dev: CogsetRow = {
  id: "d",
  name: "Dev",
  members: [],
  source: { kind: "manual" },
  lastApplied: { status: "partial", at: 1, outcomes: [] },
  createdAt: 1,
  updatedAt: 1,
}
let view: CogsetsView
jest.mock("@/hooks/plugins/use-cogsets", () => ({
  useCogsets: () => view,
  useCogsetDisplayName: () => (c: { name: string }) => c.name,
  useInstalledPluginSummaries: () => ({ plugins: [], byId: new Map(), loading: false }),
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { CogsetSwitcher } from "./cogset-switcher"

function open() {
  fireEvent.pointerDown(screen.getByTestId("cogset-switcher"), { button: 0, ctrlKey: false })
}

beforeEach(() => {
  jest.clearAllMocks()
  view = {
    cogsets: [dev, writing],
    state: { id: "host", alwaysOn: [], appliedCogsetId: "d", globalCogsetId: "d", updatedAt: 1 },
    applied: dev,
    effective: { cogset: dev, source: "global" },
    workspaceCogset: undefined,
    activeWorkspaceId: null,
    mirrored: false,
    loading: false,
  }
})

describe("CogsetSwitcher", () => {
  it("shows the effective cogset and a partial badge", () => {
    render(<CogsetSwitcher />)
    const trigger = screen.getByTestId("cogset-switcher")
    expect(trigger.textContent).toContain("Dev")
    expect(trigger.textContent).toContain("partial")
    expect(trigger.getAttribute("aria-label")).toBe('aria:{"name":"Dev"}')
  })

  it("marks a session override and a workspace binding", () => {
    view = { ...view, effective: { cogset: writing, source: "session" } }
    const { rerender } = render(<CogsetSwitcher />)
    expect(screen.getByTestId("cogset-switcher").textContent).toContain("scopeSession")
    view = { ...view, effective: { cogset: writing, source: "workspace" } }
    rerender(<CogsetSwitcher />)
    expect(screen.getByTestId("cogset-switcher").textContent).toContain("scopeWorkspace")
  })

  it("switches to another cogset and ignores the one already running", () => {
    render(<CogsetSwitcher />)
    open()
    fireEvent.click(screen.getByTestId("cogset-option-d"))
    expect(request).not.toHaveBeenCalled()
    open()
    fireEvent.click(screen.getByTestId("cogset-option-w"))
    expect(request).toHaveBeenCalledWith(writing)
  })

  it("opens the editor and the manager, and shows a pending switch", () => {
    view = {
      ...view,
      state: { ...view.state!, pending: { cogsetId: "w", reason: "runs-in-flight", since: 1 } },
    }
    render(<CogsetSwitcher />)
    expect(screen.getByTestId("cogset-switcher").textContent).toContain(
      'pending:{"name":"Writing"}'
    )
    open()
    expect(screen.getByTestId("cogset-pending").textContent).toBe(
      'pendingDetail:{"name":"Writing"}'
    )
    fireEvent.click(screen.getByText("new"))
    expect(screen.getByTestId("editor").textContent).toBe("create")
    open()
    fireEvent.click(screen.getByText("saveCurrent"))
    expect(screen.getByTestId("editor").textContent).toBe("save-current")
    open()
    fireEvent.click(screen.getByTestId("cogset-manage"))
    expect(screen.getByTestId("manager")).toBeTruthy()
  })

  it("imports a cogpack and exports the effective cogset", () => {
    render(<CogsetSwitcher />)
    open()
    fireEvent.click(screen.getByTestId("cogpack-import-item"))
    expect(cogpackPick).toHaveBeenCalled()
    open()
    fireEvent.click(screen.getByTestId("cogpack-export-item"))
    expect(screen.getByTestId("export-dialog").textContent).toBe("d")
  })

  it("offers switching only on a mirrored client", () => {
    view = { ...view, mirrored: true }
    render(<CogsetSwitcher />)
    open()
    expect(screen.queryByText("new")).toBeNull()
    expect(screen.getByText("mirroredHint")).toBeTruthy()
    expect(screen.queryByTestId("cogpack-import-item")).toBeNull()
  })
})
