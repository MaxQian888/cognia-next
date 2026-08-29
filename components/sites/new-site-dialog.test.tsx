import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Project } from "@/types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/db/sites", () => ({ createSiteProject: jest.fn() }))

import { toast } from "sonner"
import { createSiteProject } from "@/lib/db/sites"
import { NewSiteDialog } from "./new-site-dialog"

const createSiteProjectMock = createSiteProject as jest.Mock
const toastErrorMock = toast.error as jest.Mock

const PROJECT = {
  id: "project-1",
  name: "Docs project",
  roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
} as unknown as Project

const PROJECT_NO_PRIMARY = {
  id: "project-2",
  name: "Alt project",
  roots: [{ id: "root-2", path: "/alt", isPrimary: false }],
} as unknown as Project

function renderDialog(
  projects: Project[] = [PROJECT],
  activeProjectId: string | null = "project-1"
) {
  const onCreated = jest.fn()
  render(
    <NewSiteDialog
      projects={projects}
      activeProjectId={activeProjectId}
      actorAccountId="local-user"
      onCreated={onCreated}
    />
  )
  return { onCreated, user: userEvent.setup() }
}

async function fillRequired() {
  await userEvent.type(screen.getByLabelText("create.name"), "Docs")
  await userEvent.type(screen.getByLabelText("create.accountId"), "account-1")
  await userEvent.type(screen.getByLabelText("create.workerName"), "docs-worker")
}

beforeEach(() => {
  jest.clearAllMocks()
  createSiteProjectMock.mockResolvedValue({ id: "site-new" })
})

it("creates a Site from the dialog and reports the new id", async () => {
  const { onCreated, user } = renderDialog()
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  await userEvent.type(screen.getByLabelText("create.name"), "Docs")
  await userEvent.type(screen.getByLabelText("create.subpath"), "apps/docs")
  await userEvent.type(screen.getByLabelText("create.accountId"), "account-1")
  await userEvent.type(screen.getByLabelText("create.workerName"), "docs-worker")

  await user.click(screen.getByRole("button", { name: "actions.create" }))

  await waitFor(() =>
    expect(createSiteProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Docs",
        projectId: "project-1",
        sourceRoot: "/repo",
        sourceSubpath: "apps/docs",
        executionTarget: { kind: "local" },
        provider: "cloudflare",
        providerConfig: { accountId: "account-1", workerName: "docs-worker" },
        authoringPolicy: {
          ownerAccountId: "local-user",
          editorAccountIds: [],
          deployerAccountIds: [],
        },
        visitorPolicy: { mode: "private" },
      })
    )
  )
  expect(onCreated).toHaveBeenCalledWith("site-new")
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "actions.create" })).not.toBeInTheDocument()
  )
})

it("keeps create disabled until name, account, and worker are filled", async () => {
  const { user } = renderDialog()
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  const submit = screen.getByRole("button", { name: "actions.create" })
  expect(submit).toBeDisabled()
  await fillRequired()
  expect(submit).toBeEnabled()
})

it("surfaces an error when the project has no workspace root", async () => {
  const { user } = renderDialog([])
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  await fillRequired()
  await user.click(screen.getByRole("button", { name: "actions.create" }))
  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("errors.projectRoot"))
  expect(createSiteProjectMock).not.toHaveBeenCalled()
})

it("surfaces the failure message when creation throws", async () => {
  createSiteProjectMock.mockRejectedValue(new Error("worker exists"))
  const { user } = renderDialog()
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  await fillRequired()
  await user.click(screen.getByRole("button", { name: "actions.create" }))
  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("worker exists"))
})

it("stringifies a non-Error rejection", async () => {
  createSiteProjectMock.mockRejectedValue("boom")
  const { user } = renderDialog()
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  await fillRequired()
  await user.click(screen.getByRole("button", { name: "actions.create" }))
  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("boom"))
})

it("uses the first root and the switched project when there is no primary root", async () => {
  const { onCreated, user } = renderDialog([PROJECT, PROJECT_NO_PRIMARY], null)
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  fireEvent.change(screen.getByLabelText("create.project"), { target: { value: "project-2" } })
  await fillRequired()
  await user.click(screen.getByRole("button", { name: "actions.create" }))
  await waitFor(() =>
    expect(createSiteProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-2", sourceRoot: "/alt" })
    )
  )
  expect(onCreated).toHaveBeenCalledWith("site-new")
})

it("collects the zone id that add-domain has always required", async () => {
  const { user } = renderDialog()
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  await fillRequired()
  await userEvent.type(screen.getByLabelText("provider.zoneId"), " zone_1 ")
  await userEvent.type(screen.getByLabelText("provider.accessTeamName"), "acme")
  await user.click(screen.getByRole("button", { name: "actions.create" }))

  await waitFor(() =>
    expect(createSiteProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfig: {
          accountId: "account-1",
          workerName: "docs-worker",
          zoneId: "zone_1",
          accessTeamName: "acme",
        },
      })
    )
  )
})

it("omits the optional provider fields when they are left blank", async () => {
  const { user } = renderDialog()
  await user.click(screen.getByRole("button", { name: "actions.newSite" }))
  await fillRequired()
  await user.click(screen.getByRole("button", { name: "actions.create" }))

  await waitFor(() =>
    expect(createSiteProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfig: { accountId: "account-1", workerName: "docs-worker" },
      })
    )
  )
})

it("labels every field rather than leaning on placeholders", async () => {
  // Seven inputs identified only by placeholder text, which disappears the
  // moment anything is typed.
  const { user } = renderDialog()
  await user.click(screen.getByText("actions.newSite"))
  for (const key of [
    "create.project",
    "create.name",
    "create.subpath",
    "create.accountId",
    "create.workerName",
    "provider.zoneId",
    "provider.accessTeamName",
  ]) {
    expect(screen.getByLabelText(key)).toBeInTheDocument()
  }
})

it("shows the source root the Site would be created against", async () => {
  // The project picker names a project; the build runs in a directory. Saying
  // which one removes the guess.
  const { user } = renderDialog()
  await user.click(screen.getByText("actions.newSite"))
  expect(screen.getByText("/repo")).toBeInTheDocument()
})
