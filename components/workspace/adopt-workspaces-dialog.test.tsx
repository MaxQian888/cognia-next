/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const listWorkspaceEnvironments = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  listWorkspaceEnvironments: () => listWorkspaceEnvironments(),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { useProjectStore } from "@/stores/project/project-store"
import { useTerminalStore } from "@/stores/terminal/terminal-store"

import { AdoptWorkspacesDialog } from "./adopt-workspaces-dialog"

const adopt = jest.fn()

function seed(options: { roots?: string[]; terminalCwds?: string[] }) {
  useProjectStore.setState({
    projects: (options.roots ?? []).map((path, index) => ({
      id: `w${index}`,
      name: `w${index}`,
      roots: [{ id: `r${index}`, path, isPrimary: true }],
    })),
  } as unknown as Parameters<typeof useProjectStore.setState>[0])
  useTerminalStore.setState({
    sessions: Object.fromEntries(
      (options.terminalCwds ?? []).map((cwd, index) => [`t${index}`, { id: `t${index}`, cwd }])
    ),
  } as unknown as Parameters<typeof useTerminalStore.setState>[0])
}

beforeEach(() => {
  localStorage.clear()
  adopt.mockReset()
  adopt.mockReturnValue({ id: "new-workspace" })
  listWorkspaceEnvironments.mockReset()
  listWorkspaceEnvironments.mockResolvedValue([])
})

it("lists a folder in use that no workspace owns", async () => {
  seed({ roots: ["/src/app"], terminalCwds: ["/work/site"] })
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} />)

  const row = await screen.findByTestId("adopt-candidate-/work/site")
  expect(row).toHaveTextContent("site")
  expect(row).toHaveTextContent("/work/site")
})

it("says why the folder is being offered", async () => {
  // Without this the list reads as a pile of paths the app found somewhere.
  listWorkspaceEnvironments.mockResolvedValue([{ environmentId: "e1", sourceRoot: "/repos/api" }])
  seed({})
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} />)

  expect(await screen.findByTestId("adopt-candidate-/repos/api")).toHaveTextContent(
    "origin.worktree"
  )
})

it("adopts through the shared open sink, with the folder's own name", async () => {
  seed({ terminalCwds: ["/work/site"] })
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} />)

  fireEvent.click(await screen.findByTestId("adopt-candidate-/work/site-adopt"))
  expect(adopt).toHaveBeenCalledWith("/work/site", "site")
})

it("reports the adopted workspace to its caller", async () => {
  const onAdopted = jest.fn()
  seed({ terminalCwds: ["/work/site"] })
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} onAdopted={onAdopted} />)

  fireEvent.click(await screen.findByTestId("adopt-candidate-/work/site-adopt"))
  expect(onAdopted).toHaveBeenCalledWith("new-workspace")
})

it("does not report anything when the adoption was refused", async () => {
  adopt.mockReturnValue(null)
  const onAdopted = jest.fn()
  seed({ terminalCwds: ["/work/site"] })
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} onAdopted={onAdopted} />)

  fireEvent.click(await screen.findByTestId("adopt-candidate-/work/site-adopt"))
  expect(onAdopted).not.toHaveBeenCalled()
})

it("removes a dismissed folder from the list", async () => {
  seed({ terminalCwds: ["/work/site"] })
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} />)

  fireEvent.click(await screen.findByTestId("adopt-candidate-/work/site-dismiss"))
  await waitFor(() => expect(screen.queryByTestId("adopt-candidate-/work/site")).toBeNull())
})

it("says everything is accounted for rather than showing a blank dialog", async () => {
  seed({ roots: ["/src/app"], terminalCwds: ["/src/app/lib"] })
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} />)

  await waitFor(() => expect(screen.getByTestId("adopt-empty")).toHaveTextContent("empty"))
})

it("distinguishes still-scanning from nothing-to-adopt", async () => {
  // "No folders found" shown before the registry has answered would be a
  // conclusion the surface has not reached yet.
  let settle: (rows: unknown[]) => void = () => {}
  listWorkspaceEnvironments.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve as (rows: unknown[]) => void
    })
  )
  seed({})
  render(<AdoptWorkspacesDialog open onOpenChange={() => {}} adopt={adopt} />)

  expect(screen.getByTestId("adopt-empty")).toHaveTextContent("scanning")
  settle([])
  await waitFor(() => expect(screen.getByTestId("adopt-empty")).toHaveTextContent("empty"))
})
