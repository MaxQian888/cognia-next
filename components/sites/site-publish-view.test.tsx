import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type {
  SiteDeploymentRow,
  SiteEnvironmentRevisionRow,
  SiteOperationEventRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteVersionRow,
} from "@/types/sites"

const serviceMock = {
  recoverInterruptedOperations: jest.fn(async () => 0),
  saveProviderToken: jest.fn(async () => undefined),
  saveEnvironment: jest.fn(async () => undefined),
  provisionBindings: jest.fn(async () => undefined),
  uploadVersion: jest.fn(async () => undefined),
  deployVersion: jest.fn(async () => undefined),
  reconcileVisitorAccess: jest.fn(async () => undefined),
  addDomain: jest.fn(async () => undefined),
  removeDomain: jest.fn(async () => undefined),
  logs: jest.fn(async () => ({ events: [] })),
  analytics: jest.fn(async () => ({ requests: 1 })),
  takeDown: jest.fn(async () => undefined),
  restore: jest.fn(async () => undefined),
  purge: jest.fn(async () => undefined),
  reconcile: jest.fn(async () => ({ resolved: 0, remaining: 0 })),
}
type WranglerDetectionResult = { path: string | null; version: string | null; ready: boolean }
const READY_WRANGLER: WranglerDetectionResult = {
  path: "/opt/wrangler",
  version: "wrangler 3.90.0",
  ready: true,
}
const ensureWranglerApprovedMock = jest.fn(
  async (): Promise<WranglerDetectionResult> => READY_WRANGLER
)
const redetectWranglerBinaryMock = jest.fn(
  async (): Promise<WranglerDetectionResult> => READY_WRANGLER
)
const getSitePreviewSessionMock = jest.fn((..._args: unknown[]): unknown => undefined)
const startSitePreviewMock = jest.fn()
const stopSitePreviewMock = jest.fn()
const buildAndSaveSiteVersionMock = jest.fn()
const materializeSiteArtifactMock = jest.fn()
const getSiteArtifactMock = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const deleteSiteProjectMetadataMock = jest.fn((..._args: unknown[]) => undefined)

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: ({ initialUrl }: { initialUrl?: string }) => <div>preview:{initialUrl}</div>,
}))
jest.mock("@/lib/db/sites", () => ({
  deleteSiteProjectMetadata: (...args: unknown[]) => deleteSiteProjectMetadataMock(...args),
  getSiteArtifact: (...args: unknown[]) => getSiteArtifactMock(...args),
  updateSiteAuthoringPolicy: jest.fn(),
  listSiteProjects: jest.fn(),
  listSiteVersions: jest.fn(),
  listSiteDeployments: jest.fn(),
  listSiteEnvironmentRevisions: jest.fn(),
  listSiteResources: jest.fn(),
  listSiteOperations: jest.fn(),
  listSiteOperationEvents: jest.fn(),
}))
jest.mock("@/lib/file/file-operations", () => ({
  createDir: jest.fn(),
  readTextFile: jest.fn(async () => "{}"),
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
jest.mock("@/lib/sites/environment-input", () => ({
  parseSiteEnvironmentInput: () => ({}),
}))
jest.mock("@/lib/sites/manifest", () => ({
  parseSiteHostingManifest: () => ({ cloudflare: { bindings: [] } }),
}))
jest.mock("@/lib/sites/preview", () => ({
  getSitePreviewSession: (...args: unknown[]) => getSitePreviewSessionMock(...args),
  startSitePreview: (...args: unknown[]) => startSitePreviewMock(...args),
  stopSitePreview: (...args: unknown[]) => stopSitePreviewMock(...args),
}))
jest.mock("@/lib/sites/cloudflare/service", () => ({
  CloudflareSitesService: jest.fn(() => serviceMock),
}))
jest.mock("@/lib/sites/wrangler-detect", () => ({
  ensureWranglerApproved: () => ensureWranglerApprovedMock(),
  redetectWranglerBinary: () => redetectWranglerBinaryMock(),
}))

import { toast } from "sonner"
import { SitePublishView } from "./site-publish-view"

const toastErrorMock = toast.error as jest.Mock

const SITE: SiteProjectRow = {
  id: "site-1",
  name: "Docs Site",
  projectId: "project-1",
  sourceRoot: "/repo",
  sourceSubpath: "docs",
  executionTarget: { kind: "local" },
  executionTargetKey: "local",
  provider: "cloudflare",
  providerConfig: { accountId: "account-1", workerName: "docs-worker" },
  authoringPolicy: { ownerAccountId: "local-user", editorAccountIds: [], deployerAccountIds: [] },
  visitorPolicy: { mode: "private" },
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
}
const ENVIRONMENT: SiteEnvironmentRevisionRow = {
  id: "env-1",
  siteId: "site-1",
  sequence: 1,
  variables: {},
  secretRefs: [],
  createdAt: 1,
}
function version(id: string, sequence: number): SiteVersionRow {
  return {
    id,
    siteId: "site-1",
    sequence,
    status: "ready",
    environmentRevisionId: "env-1",
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
}
const UPLOADED_RESOURCE: SiteResourceRow = {
  id: "res-1",
  siteId: "site-1",
  provider: "cloudflare",
  kind: "worker-version",
  providerResourceId: "cf-version",
  displayName: "version-uploaded",
  ownership: "managed",
  status: "active",
  dependencies: [],
  createdAt: 1,
  updatedAt: 1,
}

function renderView(overrides: Partial<React.ComponentProps<typeof SitePublishView>> = {}) {
  const onDeleted = jest.fn()
  render(
    <SitePublishView
      site={SITE}
      versions={[]}
      deployments={[]}
      environments={[ENVIRONMENT]}
      resources={[]}
      operations={[]}
      events={[]}
      actorAccountId="local-user"
      onDeleted={onDeleted}
      {...overrides}
    />
  )
  return { onDeleted }
}

async function clickEnabled(name: string | RegExp) {
  const button = await screen.findByRole("button", { name })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}

beforeEach(() => {
  jest.clearAllMocks()
  ensureWranglerApprovedMock.mockResolvedValue({
    path: "/opt/wrangler",
    version: "wrangler 3.90.0",
    ready: true,
  })
  getSitePreviewSessionMock.mockReturnValue(undefined)
  startSitePreviewMock.mockResolvedValue({
    siteId: "site-1",
    terminalSessionId: "term-1",
    url: "http://localhost:3000",
  })
  stopSitePreviewMock.mockResolvedValue(undefined)
  getSiteArtifactMock.mockResolvedValue({ bytes: new Uint8Array([1]) })
  materializeSiteArtifactMock.mockResolvedValue({ entryPath: "/cache/worker.js" })
})

it("auto-detects wrangler and runs connect, environment, build, and preview", async () => {
  renderView()
  await waitFor(() =>
    expect(serviceMock.recoverInterruptedOperations).toHaveBeenCalledWith("site-1")
  )
  await screen.findByText(/wrangler.ready/)

  fireEvent.change(screen.getByPlaceholderText("provider.token"), { target: { value: "tok" } })
  await clickEnabled("actions.saveToken")
  await waitFor(() => expect(serviceMock.saveProviderToken).toHaveBeenCalledWith("site-1", "tok"))

  await clickEnabled("actions.saveEnvironment")
  await waitFor(() => expect(serviceMock.saveEnvironment).toHaveBeenCalled())

  await clickEnabled("actions.provision")
  await waitFor(() => expect(serviceMock.provisionBindings).toHaveBeenCalledWith("site-1", []))

  await clickEnabled("actions.build")
  await waitFor(() => expect(buildAndSaveSiteVersionMock).toHaveBeenCalled())

  await clickEnabled("actions.preview")
  await waitFor(() => expect(startSitePreviewMock).toHaveBeenCalled())
  await screen.findByText("preview:http://localhost:3000")

  await clickEnabled("actions.stopPreview")
  await waitFor(() => expect(stopSitePreviewMock).toHaveBeenCalledWith("site-1"))
  await waitFor(() =>
    expect(screen.queryByText("preview:http://localhost:3000")).not.toBeInTheDocument()
  )
}, 30_000)

it("uploads a ready version and deploys an uploaded one", async () => {
  renderView({
    versions: [version("version-fresh", 2), version("version-uploaded", 1)],
    resources: [UPLOADED_RESOURCE],
    deployments: [
      {
        id: "dep-1",
        siteId: "site-1",
        versionId: "version-uploaded",
        environmentRevisionId: "env-1",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      } as SiteDeploymentRow,
    ],
  })
  await screen.findByText(/wrangler.ready/)

  await clickEnabled("actions.upload")
  await waitFor(() => expect(serviceMock.uploadVersion).toHaveBeenCalled())
  expect(getSiteArtifactMock).toHaveBeenCalled()

  // The uploaded version already has a deployment, so its button rolls back.
  await clickEnabled("actions.rollback")
  await waitFor(() =>
    expect(serviceMock.deployVersion).toHaveBeenCalledWith("site-1", "version-uploaded")
  )
}, 30_000)

it("guides the user when wrangler is not found and disables upload", async () => {
  ensureWranglerApprovedMock.mockResolvedValue({ path: null, version: null, ready: false })
  renderView({ versions: [version("version-fresh", 1)] })
  await screen.findByText("wrangler.notFound")
  expect(screen.getByText("wrangler.installHint")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "actions.upload" })).toBeDisabled()

  fireEvent.click(screen.getByRole("button", { name: "actions.redetectWrangler" }))
  await waitFor(() => expect(redetectWranglerBinaryMock).toHaveBeenCalled())
})

it("streams the running operation's latest event as the build step sub-status", async () => {
  const runningBuild: SiteOperationRow = {
    id: "op-build",
    siteId: "site-1",
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: "k",
    inputDigest: "d",
    status: "running",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 5,
  }
  const events: SiteOperationEventRow[] = [
    {
      id: "e1",
      operationId: "op-build",
      sequence: 1,
      type: "claimed",
      message: "installing",
      createdAt: 1,
    },
    {
      id: "e2",
      operationId: "op-build",
      sequence: 2,
      type: "claimed",
      message: "bundling assets",
      createdAt: 2,
    },
  ]
  renderView({ operations: [runningBuild], events })
  await screen.findByText(/wrangler.ready/)
  expect(screen.getByRole("img", { name: "stepState.running" })).toBeInTheDocument()
  expect(screen.getByRole("status")).toHaveTextContent("bundling assets")
})

it("takes down an active Site", async () => {
  renderView()
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.takeDown")
  await waitFor(() => expect(serviceMock.takeDown).toHaveBeenCalledWith("site-1"))
})

it("confirms before purging a taken-down Site", async () => {
  renderView({ site: { ...SITE, lifecycle: "taken-down" } })
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.restore")
  await waitFor(() => expect(serviceMock.restore).toHaveBeenCalledWith("site-1"))

  await clickEnabled("actions.purge")
  expect(serviceMock.purge).not.toHaveBeenCalled()
  await clickEnabled("actions.confirmPurge")
  await waitFor(() => expect(serviceMock.purge).toHaveBeenCalledWith("site-1"))
}, 30_000)

it("confirms metadata deletion for a deleted Site and reports it", async () => {
  const { onDeleted } = renderView({ site: { ...SITE, lifecycle: "deleted" } })
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.deleteMetadata")
  expect(deleteSiteProjectMetadataMock).not.toHaveBeenCalled()
  await clickEnabled("actions.confirmDeleteMetadata")
  await waitFor(() => expect(deleteSiteProjectMetadataMock).toHaveBeenCalledWith("site-1"))
  expect(onDeleted).toHaveBeenCalled()
}, 30_000)

it("surfaces a failed operation via a toast", async () => {
  serviceMock.saveEnvironment.mockRejectedValueOnce(new Error("env failed"))
  renderView()
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.saveEnvironment")
  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("env failed"))
})

it("falls back to the not-found state when wrangler detection rejects", async () => {
  ensureWranglerApprovedMock.mockRejectedValueOnce(new Error("hash failed"))
  renderView({ versions: [version("version-fresh", 1)] })
  await screen.findByText("wrangler.notFound")
  expect(screen.getByRole("button", { name: "actions.upload" })).toBeDisabled()
})

it("provisions from the source root when there is no subpath", async () => {
  renderView({ site: { ...SITE, sourceSubpath: "" } })
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.provision")
  await waitFor(() => expect(serviceMock.provisionBindings).toHaveBeenCalledWith("site-1", []))
})

it("skips crash recovery for a non-owner actor", async () => {
  renderView({ actorAccountId: "someone-else" })
  await screen.findByText(/wrangler.ready/)
  expect(serviceMock.recoverInterruptedOperations).not.toHaveBeenCalled()
})

it("restores an existing preview session and edits build inputs", async () => {
  getSitePreviewSessionMock.mockReturnValue({
    siteId: "site-1",
    terminalSessionId: "term-1",
    url: "http://localhost:4000",
  })
  renderView()
  await screen.findByText("preview:http://localhost:4000")
  fireEvent.change(screen.getByPlaceholderText("build.runtime"), { target: { value: "node@22" } })
  fireEvent.change(screen.getByPlaceholderText("build.packageManager"), {
    target: { value: "npm@10" },
  })
  fireEvent.change(screen.getByPlaceholderText("build.networkHosts"), {
    target: { value: "a.com" },
  })
  fireEvent.change(screen.getByPlaceholderText("environment.variablesPlaceholder"), {
    target: { value: "X=1" },
  })
  fireEvent.change(screen.getByPlaceholderText("environment.secretsPlaceholder"), {
    target: { value: "S=2" },
  })
  expect(screen.getByDisplayValue("node@22")).toBeInTheDocument()
})

it("blocks build and preview until an environment exists", async () => {
  renderView({ environments: [] })
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.build")
  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("errors.environmentRequired"))
  toastErrorMock.mockClear()
  await clickEnabled("actions.preview")
  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("errors.environmentRequired"))
})

it("deploys an uploaded version that has no prior deployment", async () => {
  renderView({
    versions: [version("version-uploaded", 1)],
    resources: [UPLOADED_RESOURCE],
    deployments: [],
  })
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.deploy")
  await waitFor(() =>
    expect(serviceMock.deployVersion).toHaveBeenCalledWith("site-1", "version-uploaded")
  )
})

it("renders the ready state when wrangler reports no version", async () => {
  ensureWranglerApprovedMock.mockResolvedValue({
    path: "/opt/wrangler",
    version: null,
    ready: true,
  })
  renderView()
  await screen.findByText(/wrangler.ready/)
})

it("stringifies a non-Error action failure", async () => {
  serviceMock.saveEnvironment.mockRejectedValueOnce("kaput")
  renderView()
  await screen.findByText(/wrangler.ready/)
  await clickEnabled("actions.saveEnvironment")
  await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("kaput"))
})

it("shows no lifecycle action while the Site is deleting", async () => {
  renderView({ site: { ...SITE, lifecycle: "deleting" } })
  await screen.findByText(/wrangler.ready/)
  expect(screen.queryByRole("button", { name: "actions.takeDown" })).not.toBeInTheDocument()
})
