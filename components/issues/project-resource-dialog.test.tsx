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

const mockListAdapters = jest.fn(async (): Promise<unknown[]> => [])
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstancesByType: (...a: unknown[]) => mockListAdapters(...(a as [])),
}))
const mockWithApi = jest.fn(async (_opts: unknown, fn: (api: unknown) => Promise<unknown>) =>
  fn({})
)
jest.mock("@/lib/connectors/adapters/lark/authed-api", () => ({
  withLarkAuthedApi: (...a: unknown[]) =>
    mockWithApi(...(a as [unknown, (api: unknown) => Promise<unknown>])),
}))
const mockListTasklists = jest.fn(async (): Promise<unknown[]> => [])
const mockListTables = jest.fn(async (): Promise<unknown[]> => [])
const mockListFields = jest.fn(async (): Promise<unknown[]> => [])
jest.mock("@/lib/issues/sync/providers/lark-api", () => ({
  listLarkTasklists: () => mockListTasklists(),
  listBitableTables: () => mockListTables(),
  listBitableFields: () => mockListFields(),
}))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import {
  ProjectResourceDialog,
  REPO_FULL_NAME_PATTERN,
  parseBitableAppToken,
} from "./project-resource-dialog"
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

describe("parseBitableAppToken", () => {
  it("accepts a Bitable link or a bare token and refuses everything else", () => {
    expect(parseBitableAppToken("https://acme.feishu.cn/base/bascnAbCdEfGhIjKlMnOpQrStUv12")).toBe(
      "bascnAbCdEfGhIjKlMnOpQrStUv12"
    )
    expect(parseBitableAppToken(" bascnAbCdEfGhIjKlMnOpQrStUv12 ")).toBe(
      "bascnAbCdEfGhIjKlMnOpQrStUv12"
    )
    expect(parseBitableAppToken("https://acme.feishu.cn/docx/doxcnXYZ")).toBeNull()
    expect(parseBitableAppToken("not a token!")).toBeNull()
    expect(parseBitableAppToken("")).toBeNull()
  })
})

describe("binding a GitHub repo in import mode", () => {
  it("writes the sync settings with the Projects v2 number", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("resource-repo"), "acme/one")
    await user.click(screen.getByTestId("resource-sync-mode"))
    await user.click(await screen.findByRole("option", { name: "projects.syncModeImportOption" }))
    await user.type(screen.getByTestId("resource-project-v2"), "7")
    await user.click(screen.getByTestId("resource-submit"))
    await waitFor(() => expect(mockAddResource).toHaveBeenCalled())
    expect(mockAddResource).toHaveBeenCalledWith("p1", {
      kind: "github-repo",
      repoFullName: "acme/one",
      addedAt: expect.any(Number),
      sync: { mode: "import", projectV2Number: 7 },
    })
  })

  it("refuses a project number that is not a positive whole number", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByTestId("resource-repo"), "acme/one")
    await user.click(screen.getByTestId("resource-sync-mode"))
    await user.click(await screen.findByRole("option", { name: "projects.syncModeImportOption" }))
    await user.type(screen.getByTestId("resource-project-v2"), "x")
    expect(screen.getByTestId("resource-submit")).toBeDisabled()
  })
})

describe("binding a Lark tasklist", () => {
  async function switchTo(user: ReturnType<typeof userEvent.setup>, option: string) {
    await user.click(screen.getByTestId("resource-kind"))
    await user.click(await screen.findByRole("option", { name: option }))
  }

  it("says so when no Lark account is connected", async () => {
    const user = userEvent.setup()
    renderDialog()
    await switchTo(user, "projects.resourceTasklist")
    expect(await screen.findByTestId("resource-no-lark-accounts")).toBeInTheDocument()
    expect(screen.getByTestId("resource-load-tasklists")).toBeDisabled()
  })

  it("loads tasklists through the chosen account and binds the picked one", async () => {
    mockListAdapters.mockResolvedValue([
      {
        id: "cai_1",
        enabled: true,
        displayName: "Acme",
        settings: { connectedUser: { name: "Ada" } },
      },
      { id: "cai_off", enabled: false, displayName: "Off", settings: {} },
    ])
    mockListTasklists.mockResolvedValue([
      { guid: "tl-1", name: "Team tasks" },
      { guid: "tl-2", name: "Personal" },
    ])
    const user = userEvent.setup()
    renderDialog()
    await switchTo(user, "projects.resourceTasklist")
    await screen.findByTestId("resource-lark-account")
    await user.click(screen.getByTestId("resource-load-tasklists"))
    await screen.findByTestId("resource-tasklist")
    expect(mockWithApi).toHaveBeenCalledWith({ adapterId: "cai_1" }, expect.any(Function))
    await user.click(screen.getByTestId("resource-submit"))
    await waitFor(() => expect(mockAddResource).toHaveBeenCalled())
    expect(mockAddResource).toHaveBeenCalledWith("p1", {
      kind: "lark-tasklist",
      adapterId: "cai_1",
      tasklistGuid: "tl-1",
      name: "Team tasks",
      addedAt: expect.any(Number),
    })
    expect(mockSyncSchedule).toHaveBeenCalledTimes(1)
  })

  it("names the account when Lark refuses", async () => {
    mockListAdapters.mockResolvedValue([
      { id: "cai_1", enabled: true, displayName: "Acme", settings: {} },
    ])
    mockWithApi.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "notAuthorized", account: "Acme" })
    )
    const user = userEvent.setup()
    renderDialog()
    await switchTo(user, "projects.resourceTasklist")
    await screen.findByTestId("resource-lark-account")
    await user.click(screen.getByTestId("resource-load-tasklists"))
    expect(await screen.findByTestId("resource-error")).toHaveTextContent(
      "projects.larkNotAuthorized"
    )
  })
})

describe("binding a Lark Bitable table", () => {
  it("walks link, table and columns, guesses the map and writes the binding", async () => {
    mockListAdapters.mockResolvedValue([
      { id: "cai_1", enabled: true, displayName: "Acme", settings: {} },
    ])
    mockListTables.mockResolvedValue([{ tableId: "tbl", name: "Backlog" }])
    mockListFields.mockResolvedValue([
      { fieldId: "f1", name: "Title", type: 1 },
      { fieldId: "f2", name: "Status", type: 3 },
      { fieldId: "f3", name: "Owner", type: 11 },
    ])
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId("resource-kind"))
    await user.click(await screen.findByRole("option", { name: "projects.resourceBitable" }))
    await screen.findByTestId("resource-lark-account")
    await user.type(
      screen.getByTestId("resource-bitable"),
      "https://acme.feishu.cn/base/bascnAbCdEfGhIjKlMnOpQrStUv12"
    )
    await user.click(screen.getByTestId("resource-load-tables"))
    await screen.findByTestId("resource-table")
    await user.click(screen.getByTestId("resource-load-fields"))
    await screen.findByTestId("resource-field-map")
    await user.type(screen.getByTestId("resource-status-value-done"), "Finished")
    await user.click(screen.getByTestId("resource-submit"))
    await waitFor(() => expect(mockAddResource).toHaveBeenCalled())
    expect(mockAddResource).toHaveBeenCalledWith("p1", {
      kind: "lark-bitable",
      adapterId: "cai_1",
      appToken: "bascnAbCdEfGhIjKlMnOpQrStUv12",
      tableId: "tbl",
      name: "Backlog",
      fieldMap: { title: "Title", status: "Status", statusValues: { done: "Finished" } },
      addedAt: expect.any(Number),
    })
  })
})
