/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const mockAddResource = jest.fn()
jest.mock("@/lib/db/issue-projects", () => ({
  addIssueProjectResource: (...a: unknown[]) => mockAddResource(...a),
}))

const mockSyncSchedule = jest.fn()
jest.mock("@/lib/issues/github-sync-schedule", () => ({
  syncGithubIssueSchedule: (...a: unknown[]) => mockSyncSchedule(...a),
}))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { ProjectResourceDialog, REPO_FULL_NAME_PATTERN } from "./project-resource-dialog"
import type { WorkspaceRoot } from "@/types/workspace"

const ROOTS: WorkspaceRoot[] = [
  { id: "root-1", path: "/src/app", label: "app", isPrimary: true },
  { id: "root-2", path: "/src/docs" },
]

function renderDialog(overrides: Partial<React.ComponentProps<typeof ProjectResourceDialog>> = {}) {
  const props: React.ComponentProps<typeof ProjectResourceDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    issueProjectId: "p1",
    roots: ROOTS,
    ...overrides,
  }
  return { ...render(<ProjectResourceDialog {...props} />), props }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockAddResource.mockResolvedValue(undefined)
  mockSyncSchedule.mockResolvedValue({ action: "created", bindingCount: 1 })
})

describe("REPO_FULL_NAME_PATTERN", () => {
  it.each(["acme/one", "a-b.c/d_e", "Org123/repo.js"])("accepts %s", (value) => {
    expect(REPO_FULL_NAME_PATTERN.test(value)).toBe(true)
  })

  it.each(["acme", "acme/", "/one", "acme/one/two", "https://github.com/acme/one"])(
    "rejects %s",
    (value) => {
      expect(REPO_FULL_NAME_PATTERN.test(value)).toBe(false)
    }
  )
})

describe("binding a GitHub repo", () => {
  it("stays disabled until a well-formed repo is typed", async () => {
    const user = userEvent.setup()
    renderDialog()

    expect(screen.getByTestId("resource-submit")).toBeDisabled()
    await user.type(screen.getByTestId("resource-repo"), "acme")
    expect(screen.getByTestId("resource-submit")).toBeDisabled()
    expect(screen.getByTestId("resource-repo-hint")).toHaveTextContent("projects.repoInvalid")

    await user.type(screen.getByTestId("resource-repo"), "/one")
    expect(screen.getByTestId("resource-submit")).toBeEnabled()
  })

  it("refuses a repo already bound elsewhere", async () => {
    const user = userEvent.setup()
    renderDialog({ boundRepos: new Set(["acme/one"]) })

    await user.type(screen.getByTestId("resource-repo"), "acme/one")

    // Two containers claiming one repo would have each sync steal the other's
    // rows, so this is refused at the point of binding rather than diagnosed later.
    expect(screen.getByTestId("resource-repo-hint")).toHaveTextContent("projects.repoTaken")
    expect(screen.getByTestId("resource-submit")).toBeDisabled()
  })

  it("writes the binding and schedules the background refresh", async () => {
    const user = userEvent.setup()
    const { props } = renderDialog()

    await user.type(screen.getByTestId("resource-repo"), "acme/one")
    await user.click(screen.getByTestId("resource-submit"))

    await waitFor(() => expect(mockAddResource).toHaveBeenCalled())
    expect(mockAddResource).toHaveBeenCalledWith("p1", {
      kind: "github-repo",
      repoFullName: "acme/one",
      addedAt: expect.any(Number),
    })
    // Without this the executor exists but nothing ever fires it.
    expect(mockSyncSchedule).toHaveBeenCalledTimes(1)
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("trims surrounding whitespace before binding", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(screen.getByTestId("resource-repo"), "  acme/one  ")
    await user.click(screen.getByTestId("resource-submit"))

    await waitFor(() => expect(mockAddResource).toHaveBeenCalled())
    expect(mockAddResource.mock.calls[0][1].repoFullName).toBe("acme/one")
  })

  it("surfaces a write failure instead of closing silently", async () => {
    const user = userEvent.setup()
    mockAddResource.mockRejectedValue(new Error("dexie exploded"))
    const { props } = renderDialog()

    await user.type(screen.getByTestId("resource-repo"), "acme/one")
    await user.click(screen.getByTestId("resource-submit"))

    await waitFor(() =>
      expect(screen.getByTestId("resource-error")).toHaveTextContent("dexie exploded")
    )
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("reports the added resource to the caller", async () => {
    const user = userEvent.setup()
    const onAdded = jest.fn()
    renderDialog({ onAdded })

    await user.type(screen.getByTestId("resource-repo"), "acme/one")
    await user.click(screen.getByTestId("resource-submit"))

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onAdded.mock.calls[0][0]).toMatchObject({ kind: "github-repo" })
  })
})

describe("referencing a mounted directory", () => {
  async function switchToDirectory(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("resource-kind"))
    await user.click(await screen.findByRole("option", { name: "projects.resourceDirectory" }))
  }

  it("offers only directories the workspace has already mounted", async () => {
    const user = userEvent.setup()
    renderDialog()
    await switchToDirectory(user)

    await user.click(screen.getByTestId("resource-root"))
    expect(await screen.findByRole("option", { name: "app" })).toBeInTheDocument()
    // Unlabelled roots fall back to their path.
    expect(screen.getByRole("option", { name: "/src/docs" })).toBeInTheDocument()
  })

  it("hides roots this container already references", async () => {
    const user = userEvent.setup()
    renderDialog({ boundRootIds: new Set(["root-1"]) })
    await switchToDirectory(user)

    await user.click(screen.getByTestId("resource-root"))
    expect(screen.queryByRole("option", { name: "app" })).not.toBeInTheDocument()
  })

  it("explains itself when the workspace has mounted nothing — it cannot mount one", async () => {
    const user = userEvent.setup()
    renderDialog({ roots: [] })
    await switchToDirectory(user)

    // Mounting goes through the trust gate; a second path here would bypass it.
    expect(screen.getByTestId("resource-no-roots")).toBeInTheDocument()
    expect(screen.getByTestId("resource-submit")).toBeDisabled()
  })

  it("binds the first root by default without an explicit pick", async () => {
    const user = userEvent.setup()
    renderDialog()
    await switchToDirectory(user)

    await user.click(screen.getByTestId("resource-submit"))

    await waitFor(() => expect(mockAddResource).toHaveBeenCalled())
    expect(mockAddResource).toHaveBeenCalledWith("p1", {
      kind: "workspace-root",
      rootId: "root-1",
      addedAt: expect.any(Number),
    })
  })

  it("does not touch the sync schedule — only repos are syncable", async () => {
    const user = userEvent.setup()
    renderDialog()
    await switchToDirectory(user)
    await user.click(screen.getByTestId("resource-submit"))

    await waitFor(() => expect(mockAddResource).toHaveBeenCalled())
    expect(mockSyncSchedule).not.toHaveBeenCalled()
  })
})
