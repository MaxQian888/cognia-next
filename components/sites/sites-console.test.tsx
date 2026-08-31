import { fireEvent, render as baseRender, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TooltipProvider } from "@/components/ui/tooltip"

// `FeaturePageHeader` renders Radix tooltips for its responsive actions; the
// app mounts the provider in `app/layout.tsx`, so tests have to supply it.
const render = (ui: React.ReactElement) => baseRender(<TooltipProvider>{ui}</TooltipProvider>)

// The journal and versions list virtualize; jsdom reports zero height, so the
// real virtualizer renders nothing.
// The global `next/navigation` mock in jest.setup returns plain functions, so
// a deep-link test cannot vary the query string through it.
const searchParams = jest.fn(() => new URLSearchParams())
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams(),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/sites",
}))

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
        size: 64,
        end: (index + 1) * 64,
        lane: 0,
      })),
    getTotalSize: () => count * 64,
    measureElement: jest.fn(),
    scrollToIndex: jest.fn(),
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: () => "3 minutes ago", dateTime: () => "12:04" }),
  useNow: () => new Date(1_700_000_000_000),
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
// Two signals: `usePlatform` answers "can this shell drive wrangler", while
// `useCompactLayout` answers "is there room for the console".
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: jest.fn(() => false) }))
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
    busyKeys: new Set<string>(),
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
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useSiteLiveData } from "@/hooks/sites/use-site-live-data"
import type { SiteProjectRow } from "@/types/sites"
import { useSiteConsoleStore } from "@/stores/sites/site-console-store"
import { SitesConsole } from "./sites-console"

const usePlatformMock = usePlatform as jest.Mock
const useCompactLayoutMock = useCompactLayout as jest.Mock
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
  useCompactLayoutMock.mockReturnValue(false)
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

it("shows the compact overview on a narrow viewport, where ADR-0084 defers the projection", () => {
  // Width, not runtime: the console is a rail plus a detail pane, and a 375px
  // browser has no more room for it than a phone does.
  usePlatformMock.mockReturnValue("mobile")
  useCompactLayoutMock.mockReturnValue(true)
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

describe("upload vs deploy gating", () => {
  const readyVersion = {
    id: "ver_1",
    siteId: "site_1",
    sequence: 1,
    status: "ready" as const,
    environmentRevisionId: "env_1",
    source: { commitSha: "abcdef1", dirty: false, lockfileDigest: "lock", inputDigest: "in" },
    build: {
      command: '["build"]',
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-01-01",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    artifactDigest: "sha-1",
    createdAt: 1,
  }

  it("blocks upload on a host with no wrangler while deploy stays a provider question", () => {
    // The console used to pass `deployGate` for both, so the versions tab's
    // two-prop API was a lie and a missing wrangler surfaced only as a click
    // that failed.
    publishActions.wrangler = { path: null, version: null, ready: false }
    useSiteLiveDataMock.mockReturnValue(liveData({ versions: [readyVersion] }))
    render(<SitesConsole />)
    fireEvent.mouseDown(screen.getByTestId("sites-tab-versions"))

    const upload = screen.getByTestId("site-version-upload-ver_1")
    expect(upload).toBeDisabled()
    expect(upload).toHaveAttribute("title", "host.reason.requires-wrangler")
  })

  it("allows upload once wrangler resolves", () => {
    publishActions.wrangler = { path: "/bin/wrangler", version: "3", ready: true }
    useSiteLiveDataMock.mockReturnValue(liveData({ versions: [readyVersion] }))
    render(<SitesConsole />)
    fireEvent.mouseDown(screen.getByTestId("sites-tab-versions"))
    expect(screen.getByTestId("site-version-upload-ver_1")).toBeEnabled()
  })
})

describe("deep links", () => {
  beforeEach(() => {
    useSiteConsoleStore.getState().reset()
    searchParams.mockReturnValue(new URLSearchParams())
    window.history.replaceState({}, "", "/sites")
  })

  it("selects the Site a `?site=` link names", () => {
    useSiteLiveDataMock.mockReturnValue(
      liveData({ sites: [site(), site({ id: "site_2", name: "Marketing" })], selectedId: "site_1" })
    )
    searchParams.mockReturnValue(new URLSearchParams("site=site_2"))
    render(<SitesConsole />)
    expect(useSiteConsoleStore.getState().selectedId).toBe("site_2")
  })

  it("ignores a link naming a Site this profile does not have", () => {
    // The live query resolves asynchronously; selecting before the rows land
    // would make the link look broken.
    searchParams.mockReturnValue(new URLSearchParams("site=ghost"))
    render(<SitesConsole />)
    expect(useSiteConsoleStore.getState().selectedId).toBeNull()
  })

  it("opens the tab a link names", () => {
    searchParams.mockReturnValue(new URLSearchParams("site=site_1&tab=operations"))
    render(<SitesConsole />)
    expect(useSiteConsoleStore.getState().tab).toBe("operations")
    expect(screen.getByTestId("site-operations-tab")).toBeInTheDocument()
  })

  it("ignores an unrecognized tab rather than resetting the one you are on", () => {
    // Same Site as the link, so the selection effect no-ops and only the tab
    // half is under test — a stale or hand-edited value must not move you.
    useSiteConsoleStore.getState().select("site_1")
    useSiteConsoleStore.getState().setTab("versions")
    searchParams.mockReturnValue(new URLSearchParams("site=site_1&tab=nonsense"))
    render(<SitesConsole />)
    expect(useSiteConsoleStore.getState().tab).toBe("versions")
  })

  it("mirrors the selection into the URL so the page can be linked to", () => {
    // `history.replaceState`, never `router.replace`: this is a static export
    // and a route push re-evaluates the page.
    render(<SitesConsole />)
    const url = new URL(window.location.href)
    expect(url.searchParams.get("site")).toBe("site_1")
    expect(url.searchParams.get("tab")).toBe("publish")
  })

  it("moves the URL when the tab changes", () => {
    render(<SitesConsole />)
    fireEvent.mouseDown(screen.getByTestId("sites-tab-versions"))
    expect(new URL(window.location.href).searchParams.get("tab")).toBe("versions")
  })
})

describe("loading and empty states", () => {
  beforeEach(() => {
    useSiteConsoleStore.getState().reset()
    searchParams.mockReturnValue(new URLSearchParams())
  })

  it("shows a skeleton while the first read resolves, not an empty page", () => {
    // The pane was blank here, which reads as a page that failed rather than
    // one that has not finished.
    useSiteLiveDataMock.mockReturnValue(liveData({ sites: [], selectedId: null, loading: true }))
    render(<SitesConsole />)
    expect(screen.getByTestId("sites-console-loading")).toBeInTheDocument()
    expect(screen.queryByTestId("sites-console-empty")).not.toBeInTheDocument()
  })

  it("invites the first Site only once the read has settled", () => {
    // Otherwise every visit flashes an onboarding invitation.
    useSiteLiveDataMock.mockReturnValue(liveData({ sites: [], selectedId: null }))
    render(<SitesConsole />)
    expect(screen.getByTestId("sites-console-empty")).toBeInTheDocument()
    expect(screen.queryByTestId("sites-console-loading")).not.toBeInTheDocument()
  })
})
