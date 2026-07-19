import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

const createSiteProjectMock = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const listSiteProjectsMock = jest.fn(async (): Promise<SiteProjectRow[]> => [])
const deleteSiteProjectMetadataMock = jest.fn()
const getSiteArtifactMock = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const listSiteDeploymentsMock = jest.fn(async (): Promise<SiteDeploymentRow[]> => [])
const listSiteEnvironmentRevisionsMock = jest.fn(
  async (): Promise<SiteEnvironmentRevisionRow[]> => []
)
const listSiteOperationEventsMock = jest.fn(
  async (..._args: unknown[]): Promise<SiteOperationEventRow[]> => []
)
const listSiteOperationsMock = jest.fn(async (): Promise<SiteOperationRow[]> => [])
const listSiteResourcesMock = jest.fn(async (): Promise<SiteResourceRow[]> => [])
const listSiteVersionsMock = jest.fn(async (): Promise<SiteVersionRow[]> => [])
const updateSiteAuthoringPolicyMock = jest.fn()
const buildAndSaveSiteVersionMock = jest.fn()
const materializeSiteArtifactMock = jest.fn()
const approveSiteProviderToolMock = jest.fn()
const getSitePreviewSessionMock = jest.fn()
const startSitePreviewMock = jest.fn()
const stopSitePreviewMock = jest.fn()
const serviceMock = {
  recoverInterruptedOperations: jest.fn(async () => 0),
  saveProviderToken: jest.fn(),
  saveEnvironment: jest.fn(),
  provisionBindings: jest.fn(),
  uploadVersion: jest.fn(),
  deployVersion: jest.fn(),
  reconcileVisitorAccess: jest.fn(),
  addDomain: jest.fn(),
  removeDomain: jest.fn(),
  logs: jest.fn(async () => ({ events: [] })),
  analytics: jest.fn(async () => ({ requests: 1 })),
  takeDown: jest.fn(),
  restore: jest.fn(),
  purge: jest.fn(),
  reconcile: jest.fn(async () => ({ resolved: 0, remaining: 0 })),
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "local-user" }),
}))
jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: ({ initialUrl }: { initialUrl?: string }) => <div>{initialUrl}</div>,
}))
jest.mock("@/lib/db/sites", () => ({
  createSiteProject: (...args: unknown[]) => createSiteProjectMock(...args),
  deleteSiteProjectMetadata: (...args: unknown[]) => deleteSiteProjectMetadataMock(...args),
  getSiteArtifact: (...args: unknown[]) => getSiteArtifactMock(...args),
  listSiteDeployments: () => listSiteDeploymentsMock(),
  listSiteEnvironmentRevisions: () => listSiteEnvironmentRevisionsMock(),
  listSiteOperationEvents: (...args: unknown[]) => listSiteOperationEventsMock(...args),
  listSiteOperations: () => listSiteOperationsMock(),
  listSiteProjects: () => listSiteProjectsMock(),
  listSiteResources: () => listSiteResourcesMock(),
  listSiteVersions: () => listSiteVersionsMock(),
  updateSiteAuthoringPolicy: (...args: unknown[]) => updateSiteAuthoringPolicyMock(...args),
}))
jest.mock("@/lib/file/file-operations", () => ({
  createDir: jest.fn(),
  readTextFile: jest.fn(async () =>
    JSON.stringify({
      schemaVersion: 1,
      build: { command: ["pnpm", "build"], entry: "dist/worker.js" },
      preview: { command: ["pnpm", "dev"], url: "http://localhost:3000" },
      cloudflare: { compatibilityDate: "2026-07-18", compatibilityFlags: [], bindings: [] },
    })
  ),
}))
jest.mock("@tauri-apps/api/path", () => ({
  appCacheDir: jest.fn(async () => "/cache"),
  join: jest.fn(async (...parts: string[]) => parts.join("/")),
}))
jest.mock("@/lib/sites/build-version", () => ({
  buildAndSaveSiteVersion: (...args: unknown[]) => buildAndSaveSiteVersionMock(...args),
}))
jest.mock("@/lib/sites/artifact-package", () => ({
  materializeSiteArtifact: (...args: unknown[]) => materializeSiteArtifactMock(...args),
}))
jest.mock("@/lib/sites/approved-tool", () => ({
  approveSiteProviderTool: (...args: unknown[]) => approveSiteProviderToolMock(...args),
}))
jest.mock("@/lib/sites/cloudflare/service", () => ({
  CloudflareSitesService: jest.fn(() => serviceMock),
}))
jest.mock("@/lib/sites/preview", () => ({
  getSitePreviewSession: (...args: unknown[]) => getSitePreviewSessionMock(...args),
  startSitePreview: (...args: unknown[]) => startSitePreviewMock(...args),
  stopSitePreview: (...args: unknown[]) => stopSitePreviewMock(...args),
}))

import { useProjectStore } from "@/stores/project/project-store"
import type { Project } from "@/types"
import { SitesDashboard } from "./sites-dashboard"

const ACTIVE_SITE: SiteProjectRow = {
  id: "site-1",
  name: "Docs Site",
  projectId: "project-1",
  sourceRoot: "/repo",
  sourceSubpath: "apps/docs",
  executionTarget: { kind: "local" },
  executionTargetKey: "local",
  provider: "cloudflare",
  providerConfig: { accountId: "account-1", workerName: "docs-worker", zoneId: "zone-1" },
  authoringPolicy: {
    ownerAccountId: "local-user",
    editorAccountIds: [],
    deployerAccountIds: [],
  },
  visitorPolicy: { mode: "private" },
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
}

const ENVIRONMENT: SiteEnvironmentRevisionRow = {
  id: "environment-1",
  siteId: "site-1",
  sequence: 1,
  variables: {},
  secretRefs: [],
  createdAt: 1,
}

const VERSION_BASE = {
  siteId: "site-1",
  status: "ready" as const,
  environmentRevisionId: ENVIRONMENT.id,
  source: {
    commitSha: "abc123",
    dirty: false,
    lockfileDigest: "a".repeat(64),
    inputDigest: "b".repeat(64),
  },
  build: {
    command: "pnpm build",
    runtime: "node@24",
    packageManager: "pnpm@10",
    compatibilityDate: "2026-07-18",
    compatibilityFlags: [],
    routes: [],
    bindings: [],
  },
  artifactDigest: "c".repeat(64),
  createdAt: 1,
  completedAt: 2,
}

function prepareSelectedSite(lifecycle: SiteProjectRow["lifecycle"] = "active") {
  const site = { ...ACTIVE_SITE, lifecycle }
  listSiteProjectsMock.mockResolvedValue([site])
  listSiteEnvironmentRevisionsMock.mockResolvedValue([ENVIRONMENT])
  listSiteVersionsMock.mockResolvedValue([
    { ...VERSION_BASE, id: "version-upload", sequence: 1 },
    { ...VERSION_BASE, id: "version-deploy", sequence: 2 },
  ])
  listSiteDeploymentsMock.mockResolvedValue([])
  listSiteResourcesMock.mockResolvedValue([
    {
      id: "resource-version",
      siteId: site.id,
      provider: "cloudflare",
      kind: "worker-version",
      providerResourceId: "cf-version",
      displayName: "version-deploy",
      ownership: "managed",
      status: "active",
      dependencies: [],
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "resource-domain",
      siteId: site.id,
      provider: "cloudflare",
      kind: "custom-domain",
      providerResourceId: "domain-1",
      displayName: "docs.example.com",
      ownership: "managed",
      status: "active",
      dependencies: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ])
  listSiteOperationsMock.mockResolvedValue([
    {
      id: "operation-1",
      siteId: site.id,
      type: "deploy",
      executionTargetKey: "local",
      idempotencyKey: "deploy-1",
      inputDigest: "digest",
      status: "succeeded",
      attemptCount: 1,
      createdAt: 1,
      updatedAt: 2,
    },
  ])
  listSiteOperationEventsMock.mockResolvedValue([
    {
      id: "event-1",
      operationId: "operation-1",
      sequence: 1,
      type: "succeeded",
      createdAt: 2,
    },
  ])
  return site
}

async function clickEnabled(name: string) {
  const button = screen.getByRole("button", { name })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}

beforeEach(() => {
  jest.clearAllMocks()
  listSiteProjectsMock.mockResolvedValue([])
  listSiteDeploymentsMock.mockResolvedValue([])
  listSiteEnvironmentRevisionsMock.mockResolvedValue([])
  listSiteOperationEventsMock.mockResolvedValue([])
  listSiteOperationsMock.mockResolvedValue([])
  listSiteResourcesMock.mockResolvedValue([])
  listSiteVersionsMock.mockResolvedValue([])
  createSiteProjectMock.mockResolvedValue({ id: "site-created" })
  getSitePreviewSessionMock.mockReturnValue(undefined)
  startSitePreviewMock.mockResolvedValue({
    siteId: "site-1",
    terminalSessionId: "terminal-1",
    url: "http://localhost:3000",
  })
  materializeSiteArtifactMock.mockResolvedValue({ entryPath: "/cache/worker.js" })
  useProjectStore.setState({
    loaded: true,
    activeProjectId: "project-1",
    projects: [
      {
        id: "project-1",
        name: "Docs project",
        roots: [{ id: "root-1", path: "/repo", isPrimary: true }],
        rootDir: "/repo",
        additionalDirs: [],
        description: "",
        knowledgeBase: [],
        linkedSessions: [],
        sessionIds: [],
        sessionCount: 0,
        messageCount: 0,
        tags: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        lastAccessedAt: new Date(),
        isArchived: false,
      } as Project,
    ],
  })
})

it("creates a Cognia Site linked to an existing project root", async () => {
  render(<SitesDashboard />)
  fireEvent.change(screen.getByPlaceholderText("create.name"), { target: { value: "Docs" } })
  fireEvent.change(screen.getByPlaceholderText("create.subpath"), {
    target: { value: "apps/docs" },
  })
  fireEvent.change(screen.getByPlaceholderText("create.accountId"), {
    target: { value: "account-1" },
  })
  fireEvent.change(screen.getByPlaceholderText("create.workerName"), {
    target: { value: "docs-worker" },
  })
  fireEvent.click(screen.getByRole("button", { name: /actions.create/ }))

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
      })
    )
  )
})

it("runs the complete Cognia-owned Site lifecycle from the dashboard", async () => {
  const user = userEvent.setup()
  prepareSelectedSite()
  getSiteArtifactMock.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]) })
  startSitePreviewMock.mockImplementation(async () => {
    const session = {
      siteId: "site-1",
      terminalSessionId: "terminal-1",
      url: "http://localhost:3000",
    }
    getSitePreviewSessionMock.mockReturnValue(session)
    return session
  })
  stopSitePreviewMock.mockImplementation(async () => {
    getSitePreviewSessionMock.mockReturnValue(undefined)
  })

  render(<SitesDashboard />)
  await screen.findByRole("heading", { name: "Docs Site" })
  await waitFor(() => expect(serviceMock.recoverInterruptedOperations).toHaveBeenCalled())

  fireEvent.change(screen.getByPlaceholderText("environment.variablesPlaceholder"), {
    target: { value: "ORIGIN=https://example.com" },
  })
  fireEvent.change(screen.getByPlaceholderText("environment.secretsPlaceholder"), {
    target: { value: "TOKEN=secret" },
  })
  await clickEnabled("actions.saveEnvironment")
  await waitFor(() => expect(serviceMock.saveEnvironment).toHaveBeenCalled())

  await clickEnabled("actions.provision")
  await waitFor(() => expect(serviceMock.provisionBindings).toHaveBeenCalled())
  await clickEnabled("actions.build")
  await waitFor(() => expect(buildAndSaveSiteVersionMock).toHaveBeenCalled())
  await clickEnabled("actions.preview")
  await waitFor(() => expect(startSitePreviewMock).toHaveBeenCalled())
  await screen.findByText("http://localhost:3000")
  await clickEnabled("actions.stopPreview")
  await waitFor(() => expect(stopSitePreviewMock).toHaveBeenCalled())

  await user.click(screen.getByRole("tab", { name: "tabs.versions" }))
  fireEvent.change(await screen.findByPlaceholderText("versions.wranglerPath"), {
    target: { value: "/opt/wrangler" },
  })
  await clickEnabled("actions.approveTool")
  await waitFor(() => expect(approveSiteProviderToolMock).toHaveBeenCalledWith("/opt/wrangler"))
  await clickEnabled("actions.upload")
  await waitFor(() => expect(serviceMock.uploadVersion).toHaveBeenCalled())
  await clickEnabled("actions.deploy")
  await waitFor(() => expect(serviceMock.deployVersion).toHaveBeenCalled())
  expect(screen.getByText(/operations.eventCount/)).toBeInTheDocument()

  await user.click(screen.getByRole("tab", { name: "tabs.access" }))
  fireEvent.change(await screen.findByRole("combobox", { name: "access.mode" }), {
    target: { value: "identities" },
  })
  fireEvent.change(screen.getByPlaceholderText("access.values"), {
    target: { value: "user@example.com" },
  })
  fireEvent.change(screen.getByPlaceholderText("access.hostname"), {
    target: { value: "docs.example.com" },
  })
  await clickEnabled("actions.saveAccess")
  await waitFor(() => expect(serviceMock.reconcileVisitorAccess).toHaveBeenCalled())

  await user.click(screen.getByRole("tab", { name: "tabs.domains" }))
  fireEvent.change(await screen.findByPlaceholderText("domains.hostname"), {
    target: { value: "new.example.com" },
  })
  await clickEnabled("actions.addDomain")
  await waitFor(() => expect(serviceMock.addDomain).toHaveBeenCalled())
  await clickEnabled("actions.remove")
  await waitFor(() => expect(serviceMock.removeDomain).toHaveBeenCalled())

  await user.click(screen.getByRole("tab", { name: "tabs.observability" }))
  await clickEnabled("actions.loadLogs")
  await waitFor(() => expect(serviceMock.logs).toHaveBeenCalled())
  await clickEnabled("actions.loadAnalytics")
  await waitFor(() => expect(serviceMock.analytics).toHaveBeenCalled())

  await user.click(screen.getByRole("tab", { name: "tabs.provider" }))
  fireEvent.change(await screen.findByPlaceholderText("provider.token"), {
    target: { value: "provider-token" },
  })
  await clickEnabled("actions.saveToken")
  await waitFor(() => expect(serviceMock.saveProviderToken).toHaveBeenCalled())
  await clickEnabled("actions.reconcile")
  await waitFor(() => expect(serviceMock.reconcile).toHaveBeenCalled())
  await clickEnabled("actions.saveAuthoring")
  await waitFor(() => expect(updateSiteAuthoringPolicyMock).toHaveBeenCalled())

  await clickEnabled("actions.takeDown")
  await waitFor(() => expect(serviceMock.takeDown).toHaveBeenCalled())
}, 30_000)

it("requires explicit confirmation before purging a taken-down Site", async () => {
  prepareSelectedSite("taken-down")
  render(<SitesDashboard />)
  await screen.findByRole("heading", { name: "Docs Site" })

  await clickEnabled("actions.restore")
  await waitFor(() => expect(serviceMock.restore).toHaveBeenCalledWith("site-1"))
  await clickEnabled("actions.purge")
  expect(serviceMock.purge).not.toHaveBeenCalled()
  await clickEnabled("actions.confirmPurge")
  await waitFor(() => expect(serviceMock.purge).toHaveBeenCalledWith("site-1"))
  expect(deleteSiteProjectMetadataMock).not.toHaveBeenCalled()
}, 30_000)

it("separately confirms local metadata deletion after provider purge completes", async () => {
  prepareSelectedSite("deleted")
  render(<SitesDashboard />)
  await screen.findByRole("heading", { name: "Docs Site" })

  await clickEnabled("actions.deleteMetadata")
  expect(deleteSiteProjectMetadataMock).not.toHaveBeenCalled()
  await clickEnabled("actions.confirmDeleteMetadata")
  await waitFor(() => expect(deleteSiteProjectMetadataMock).toHaveBeenCalledWith("site-1"))
  expect(serviceMock.purge).not.toHaveBeenCalled()
}, 30_000)
