/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
let view: Record<string, unknown>
jest.mock("@/hooks/plugins/use-cogsets", () => ({
  useCogsets: () => view,
  useCogsetDisplayName: () => (c: { name: string }) => c.name,
}))
const setWorkspaceCogset = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/plugin/cogset/actions", () => ({
  setWorkspaceCogset: (...a: unknown[]) => setWorkspaceCogset(...a),
}))
let projects: Array<{ id: string; pluginCogsetId?: string }> = []
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (select: (s: { projects: typeof projects }) => unknown) => select({ projects }),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { WorkspaceCogsetBinding } from "./workspace-cogset-binding"

const { toast } = jest.requireMock("sonner") as { toast: { success: jest.Mock; error: jest.Mock } }

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  jest.clearAllMocks()
  projects = [{ id: "p1" }]
  view = {
    cogsets: [
      { id: "g", name: "Global", source: { kind: "manual" } },
      { id: "w", name: "Writing", source: { kind: "manual" } },
    ],
    state: { globalCogsetId: "g" },
    mirrored: false,
    loading: false,
  }
})

function choose(label: string) {
  fireEvent.click(screen.getByTestId("workspace-cogset-select"))
  fireEvent.click(screen.getByRole("option", { name: label }))
}

describe("WorkspaceCogsetBinding", () => {
  it("follows the default until a cogset is chosen, and binds it", async () => {
    render(<WorkspaceCogsetBinding workspaceId="p1" />)
    expect(screen.getByTestId("workspace-cogset-select").textContent).toContain(
      'followGlobal:{"name":"Global"}'
    )
    choose("Writing")
    await waitFor(() => expect(setWorkspaceCogset).toHaveBeenCalledWith("p1", "w"))
    expect(toast.success).toHaveBeenCalledWith('saved:{"name":"Writing"}')
  })

  it("unbinds back to the default", async () => {
    projects = [{ id: "p1", pluginCogsetId: "w" }]
    render(<WorkspaceCogsetBinding workspaceId="p1" />)
    expect(screen.getByTestId("workspace-cogset-select").textContent).toContain("Writing")
    choose('followGlobal:{"name":"Global"}')
    await waitFor(() => expect(setWorkspaceCogset).toHaveBeenCalledWith("p1", undefined))
    expect(toast.success).toHaveBeenCalledWith("cleared")
  })

  it("treats a binding to a deleted cogset as following the default", () => {
    projects = [{ id: "p1", pluginCogsetId: "deleted" }]
    render(<WorkspaceCogsetBinding workspaceId="p1" />)
    expect(screen.getByTestId("workspace-cogset-select").textContent).toContain("followGlobal")
  })

  it("is disabled without a workspace and on a mirrored client", () => {
    const { rerender } = render(<WorkspaceCogsetBinding workspaceId={null} />)
    expect(screen.getByText("noWorkspace")).toBeTruthy()
    expect((screen.getByTestId("workspace-cogset-select") as HTMLButtonElement).disabled).toBe(true)
    view = { ...view, mirrored: true }
    rerender(<WorkspaceCogsetBinding workspaceId="p1" />)
    expect(screen.getByText("mirrored")).toBeTruthy()
  })

  it("toasts a failure", async () => {
    setWorkspaceCogset.mockRejectedValueOnce(new Error("nope"))
    render(<WorkspaceCogsetBinding workspaceId="p1" />)
    choose("Writing")
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("failed", { description: "nope" }))
  })
})
