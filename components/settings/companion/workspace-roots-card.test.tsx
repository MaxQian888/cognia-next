/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/files/workspace-fs", () => ({ listWorkspaceRoots: jest.fn() }))

import { WorkspaceRootsCard } from "./workspace-roots-card"

const listWorkspaceRootsMock = (
  jest.requireMock("@/lib/files/workspace-fs") as { listWorkspaceRoots: jest.Mock }
).listWorkspaceRoots

beforeEach(() => {
  listWorkspaceRootsMock.mockReset().mockResolvedValue([])
})

it("names each allowed folder and where that folder is configured", async () => {
  listWorkspaceRootsMock.mockResolvedValue([
    { path: "/srv/workspaces", source: "headless-workspaces-dir" },
    { path: "/Users/me/code", source: "desktop-project" },
  ])

  render(<WorkspaceRootsCard />)

  expect(await screen.findByText("/srv/workspaces")).toBeInTheDocument()
  expect(screen.getByText("/Users/me/code")).toBeInTheDocument()
  // Knowing the path is only half of it: the two Hosts are configured in
  // different places, and a card that lists paths without saying which is which
  // leaves the user with nowhere to go.
  expect(screen.getByText("sourceHeadless")).toBeInTheDocument()
  expect(screen.getByText("hintHeadless")).toBeInTheDocument()
  expect(screen.getByText("sourceDesktop")).toBeInTheDocument()
  expect(screen.getByText("hintDesktop")).toBeInTheDocument()
})

it("says the Host reported nothing rather than showing an empty list", async () => {
  listWorkspaceRootsMock.mockResolvedValue([])

  render(<WorkspaceRootsCard />)

  expect(await screen.findByText("empty")).toBeInTheDocument()
})

it("surfaces a read failure instead of looking like an empty allowlist", async () => {
  listWorkspaceRootsMock.mockRejectedValue(new Error("offline"))

  render(<WorkspaceRootsCard />)

  expect(await screen.findByText("loadError")).toBeInTheDocument()
  expect(screen.queryByText("empty")).not.toBeInTheDocument()
})

it("re-reads the roots on demand, because the Host can be restarted under it", async () => {
  listWorkspaceRootsMock
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ path: "/srv/new", source: "headless-workspaces-dir" }])

  render(<WorkspaceRootsCard />)
  await screen.findByText("empty")

  fireEvent.click(screen.getByRole("button", { name: "refresh" }))

  await waitFor(() => expect(screen.getByText("/srv/new")).toBeInTheDocument())
})
