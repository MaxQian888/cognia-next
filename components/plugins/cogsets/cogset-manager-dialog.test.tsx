/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ relativeTime: () => "just now" }),
}))
const actions = {
  createCogsetFromPlugins: jest.fn(async () => ({ id: "copy" })),
  editCogset: jest.fn(async () => undefined),
  setGlobalCogset: jest.fn(async () => undefined),
  setPluginAlwaysOn: jest.fn(async () => undefined),
}
jest.mock("@/lib/plugin/cogset/actions", () => ({
  createCogsetFromPlugins: (...a: unknown[]) => actions.createCogsetFromPlugins(...(a as [])),
  editCogset: (...a: unknown[]) => actions.editCogset(...(a as [])),
  setGlobalCogset: (...a: unknown[]) => actions.setGlobalCogset(...(a as [])),
  setPluginAlwaysOn: (...a: unknown[]) => actions.setPluginAlwaysOn(...(a as [])),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CogsetsView } from "@/hooks/plugins/use-cogsets"
import type { CogsetRow } from "@/types/plugin/plugin-cogset"

import { CogsetManagerDialog, type CogsetManagerDialogProps } from "./cogset-manager-dialog"

const writing: CogsetRow = {
  id: "w",
  name: "Writing",
  description: "Long form",
  members: [
    { pluginId: "pdf", expectedVersion: "1.0.0" },
    { pluginId: "gone", optional: true },
  ],
  source: {
    kind: "cogpack",
    cogpackId: "deep-writer",
    version: "2.0.0",
    fingerprint: "f",
    installId: "i",
  },
  lastApplied: {
    status: "partial",
    at: 1,
    outcomes: [
      { pluginId: "gone", action: "enable", ok: false, reason: "not-installed", optional: true },
    ],
  },
  createdAt: 1,
  updatedAt: 1,
}
const dev: CogsetRow = {
  id: "d",
  name: "Dev",
  members: [],
  source: { kind: "manual" },
  createdAt: 1,
  updatedAt: 1,
}

function props(overrides: Partial<CogsetManagerDialogProps> = {}, view: Partial<CogsetsView> = {}) {
  const base: CogsetManagerDialogProps = {
    open: true,
    onOpenChange: jest.fn(),
    view: {
      cogsets: [dev, writing],
      state: {
        id: "host",
        alwaysOn: ["core"],
        globalCogsetId: "d",
        appliedCogsetId: "w",
        updatedAt: 1,
      },
      applied: writing,
      effective: { cogset: writing, source: "session" },
      workspaceCogset: undefined,
      activeWorkspaceId: null,
      mirrored: false,
      loading: false,
      ...view,
    },
    displayName: (c) => c.name,
    pluginName: (id) => `n:${id}`,
    isInstalled: (id) => id !== "gone",
    onSwitch: jest.fn(),
    onRetry: jest.fn(),
    onCreate: jest.fn(),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    onExport: jest.fn(),
    ...overrides,
  }
  return base
}

beforeEach(() => jest.clearAllMocks())

describe("CogsetManagerDialog", () => {
  it("shows the effective cogset with its status, members, source and last result", () => {
    render(<CogsetManagerDialog {...props()} />)
    const detail = screen.getByTestId("cogset-detail")
    expect(detail.textContent).toContain("Writing")
    expect(detail.textContent).toContain('source.cogpack:{"name":"deep-writer","version":"2.0.0"}')
    expect(screen.getByText('memberPinned:{"version":"1.0.0"}')).toBeTruthy()
    expect(screen.getByText("memberMissing")).toBeTruthy()
    expect(screen.getByText("lastPartial")).toBeTruthy()
    fireEvent.click(screen.getByText("retry"))
    expect(screen.queryByTestId("cogset-manager-switch")).toBeNull()
  })

  it("switches, edits, exports, deletes and makes another cogset the default", async () => {
    const p = props()
    render(<CogsetManagerDialog {...p} />)
    fireEvent.click(screen.getByRole("button", { name: /Dev/ }))
    fireEvent.click(screen.getByTestId("cogset-manager-switch"))
    expect(p.onSwitch).toHaveBeenCalledWith(dev)
    fireEvent.click(screen.getByText("edit"))
    expect(p.onEdit).toHaveBeenCalledWith(dev)
    fireEvent.click(screen.getByText("export"))
    expect(p.onExport).toHaveBeenCalledWith(dev)
    fireEvent.click(screen.getByText("delete"))
    expect(p.onDelete).toHaveBeenCalledWith(dev)
    fireEvent.click(screen.getByRole("button", { name: /Writing/ }))
    fireEvent.click(screen.getByText("makeDefault"))
    await waitFor(() => expect(actions.setGlobalCogset).toHaveBeenCalledWith("w"))
  })

  it("duplicates with the same members", async () => {
    render(<CogsetManagerDialog {...props()} />)
    fireEvent.click(screen.getByText("duplicate"))
    await waitFor(() =>
      expect(actions.editCogset).toHaveBeenCalledWith("copy", { members: writing.members })
    )
    expect(actions.createCogsetFromPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'duplicateName:{"name":"Writing"}', pluginIds: [] })
    )
  })

  it("removes a plugin from always on", async () => {
    render(<CogsetManagerDialog {...props()} />)
    fireEvent.click(screen.getByLabelText('alwaysOnRemove:{"name":"n:core"}'))
    await waitFor(() => expect(actions.setPluginAlwaysOn).toHaveBeenCalledWith("core", false))
  })

  it("is read-only apart from switching on a mirrored client", () => {
    render(<CogsetManagerDialog {...props({}, { mirrored: true })} />)
    expect(screen.getByText("mirroredHint")).toBeTruthy()
    expect(screen.queryByText("edit")).toBeNull()
    expect(screen.queryByText("delete")).toBeNull()
    expect(screen.queryByLabelText(/alwaysOnRemove/)).toBeNull()
  })

  it("says when there are no cogsets", () => {
    render(
      <CogsetManagerDialog {...props({}, { cogsets: [], applied: undefined, effective: null })} />
    )
    expect(screen.getByText("empty")).toBeTruthy()
  })
})
