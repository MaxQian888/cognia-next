import { fireEvent, render as baseRender, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"

// `FeaturePageHeader` renders Radix tooltips for its responsive actions; the
// app mounts the provider in `app/layout.tsx`, so tests have to supply it.
const render = (ui: React.ReactElement) => baseRender(<TooltipProvider>{ui}</TooltipProvider>)

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: () => "3 minutes ago", dateTime: () => "12:04" }),
  useNow: () => new Date(1_700_000_000_000),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
jest.mock("@/hooks/sites/use-site-live-data", () => {
  const actual = jest.requireActual("@/hooks/sites/use-site-live-data")
  return { ...actual, useSiteLiveData: jest.fn() }
})
jest.mock("@/hooks/sites/use-site-hosting-manifest", () => ({
  useSiteHostingManifest: jest.fn(() => ({
    state: { status: "missing", path: "/p" },
    ready: false,
    text: "",
    refresh: jest.fn(),
    scaffold: jest.fn(),
    save: jest.fn(),
  })),
}))
jest.mock("@/hooks/sites/use-site-preview-session", () => ({
  useSitePreviewSession: () => ({ url: null, resolved: true, adopt: jest.fn() }),
}))
const publishActions = {
  stepStates: {
    connect: "idle",
    manifest: "idle",
    environment: "idle",
    build: "idle",
    preview: "idle",
    publish: "idle",
  },
  readyVersions: [],
  wrangler: null,
  saveToken: jest.fn(),
  saveManifest: jest.fn(),
  saveEnvironment: jest.fn(),
  provision: jest.fn(),
  build: jest.fn(),
  startPreview: jest.fn(),
  stopPreview: jest.fn(),
  redetectWrangler: jest.fn(),
  upload: jest.fn(),
  deploy: jest.fn(),
  addDomain: jest.fn(),
  removeDomain: jest.fn(),
  applyAccess: jest.fn(),
  takeDown: jest.fn(),
  restore: jest.fn(),
  reconcile: jest.fn(),
  refreshOperation: jest.fn(),
  cancelOperation: jest.fn(),
}
jest.mock("@/hooks/sites/use-site-publish-actions", () => ({
  useSitePublishActions: () => publishActions,
}))
const purge = jest.fn(async () => undefined)
jest.mock("@/hooks/sites/use-site-actions", () => ({
  useSiteActions: () => ({
    busy: null,
    isBusy: () => false,
    service: () => ({ purge }),
    run: jest.fn(async (_key: string, action: () => Promise<unknown>) => action()),
  }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: [], activeProjectId: null, load: jest.fn() }),
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "owner" }),
}))
jest.mock("@/lib/db/sites", () => ({
  deleteSiteProjectMetadata: jest.fn(async () => undefined),
  getSiteArtifact: jest.fn(async () => undefined),
  updateSiteProviderConfig: jest.fn(async () => undefined),
}))
jest.mock("./new-site-dialog", () => ({
  NewSiteDialog: () => <button type="button">new-site</button>,
}))

import { usePlatform } from "@/hooks/use-platform"
import { useSiteLiveData } from "@/hooks/sites/use-site-live-data"
import type { SiteProjectRow } from "@/types/sites"
import { SitesConsole } from "./sites-console"

const usePlatformMock = usePlatform as jest.Mock
const useSiteLiveDataMock = useSiteLiveData as unknown as jest.Mock

function site(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "a", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function liveData(overrides: Record<string, unknown> = {}) {
  return {
    sites: [site()],
    selectedId: "site_1",
    activeDeployments: [],
    operationSignals: [],
    versions: [],
    deployments: [],
    environments: [],
    resources: [],
    operations: [],
    loading: false,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  usePlatformMock.mockReturnValue("tauri")
  useSiteLiveDataMock.mockReturnValue(liveData())
})

it("renders the whole console in the browser instead of a desktop-only card", () => {
  usePlatformMock.mockReturnValue("web")
  render(<SitesConsole />)

  expect(screen.getByTestId("sites-console")).toBeInTheDocument()
  expect(screen.getByTestId("site-rail")).toBeInTheDocument()
  expect(screen.getByTestId("site-overview-header")).toBeInTheDocument()
  expect(screen.getByTestId("sites-host-banner")).toBeInTheDocument()
  expect(screen.queryByTestId("sites-mobile-notice")).not.toBeInTheDocument()
})

it("disables host-privileged actions in the browser rather than hiding them", () => {
  usePlatformMock.mockReturnValue("web")
  render(<SitesConsole />)

  const takeDown = screen.getByTestId("site-take-down")
  expect(takeDown).toBeDisabled()
  expect(takeDown).toHaveAttribute("title", "host.reason.requires-desktop")
  expect(screen.getByTestId("site-save-token")).toBeDisabled()
})

it("keeps the desktop-only card on the phone, where ADR-0084 defers the projection", () => {
  usePlatformMock.mockReturnValue("mobile")
  render(<SitesConsole />)

  expect(screen.getByTestId("sites-mobile-notice")).toBeInTheDocument()
  expect(screen.queryByTestId("sites-console")).not.toBeInTheDocument()
})

it("shows no host banner on the desktop", () => {
  render(<SitesConsole />)
  expect(screen.queryByTestId("sites-host-banner")).not.toBeInTheDocument()
})

it("opens on the publish flow and switches tabs", () => {
  render(<SitesConsole />)
  expect(screen.getByTestId("site-publish-tab")).toBeInTheDocument()

  // Radix Tabs activates on mousedown, not on the synthesized click sequence.
  fireEvent.mouseDown(screen.getByTestId("sites-tab-operations"))
  expect(screen.getByTestId("site-operations-tab")).toBeInTheDocument()
  expect(screen.queryByTestId("site-publish-tab")).not.toBeInTheDocument()

  fireEvent.mouseDown(screen.getByTestId("sites-tab-resources"))
  expect(screen.getByTestId("site-resources-empty")).toBeInTheDocument()
})

it("invites the first Site when none exists, with the tabs disabled", () => {
  useSiteLiveDataMock.mockReturnValue(liveData({ sites: [], selectedId: null }))
  render(<SitesConsole />)
  expect(screen.getByText("empty")).toBeInTheDocument()
  expect(screen.getByTestId("sites-tab-publish")).toBeDisabled()
})

it("selects a Site from the rail", async () => {
  const user = userEvent.setup()
  useSiteLiveDataMock.mockReturnValue(
    liveData({ sites: [site(), site({ id: "site_2", name: "Marketing" })] })
  )
  render(<SitesConsole />)
  await user.click(screen.getByTestId("site-rail-row-site_2"))
  expect(useSiteLiveDataMock).toHaveBeenLastCalledWith("site_2")
})

it("reports what a purge would keep before confirming it", async () => {
  const user = userEvent.setup()
  useSiteLiveDataMock.mockReturnValue(
    liveData({
      sites: [site({ lifecycle: "taken-down" })],
      resources: [
        {
          id: "m1",
          siteId: "site_1",
          provider: "cloudflare",
          kind: "worker",
          providerResourceId: "cf",
          ownership: "managed",
          status: "active",
          dependencies: [],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "a1",
          siteId: "site_1",
          provider: "cloudflare",
          kind: "d1-database",
          providerResourceId: "cf2",
          ownership: "adopted",
          status: "active",
          dependencies: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
  )
  render(<SitesConsole />)

  await user.click(screen.getByTestId("site-purge"))
  const scope = await screen.findByTestId("site-purge-scope")
  expect(scope).toHaveTextContent('resources.retention.purgeable:{"count":1}')
  expect(scope).toHaveTextContent('resources.retention.retained:{"count":1}')

  await user.click(screen.getByText("actions.confirmPurge"))
  expect(purge).toHaveBeenCalledWith("site_1")
})
