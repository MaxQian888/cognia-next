import { fireEvent, render, screen } from "@testing-library/react"
import type { SiteProjectRow } from "@/types/sites"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/stores/project/project-store", () => {
  const load = jest.fn()
  return {
    useProjectStore: (selector: (state: unknown) => unknown) =>
      selector({ projects: [], activeProjectId: "project-1", load }),
  }
})
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: { unlockedAccountId: string }) => unknown) =>
    selector({ unlockedAccountId: "local-user" }),
}))
jest.mock("@/hooks/sites/use-site-live-data", () => ({ useSiteLiveData: jest.fn() }))
jest.mock("./site-publish-view", () => ({
  SitePublishView: ({ site, onDeleted }: { site: SiteProjectRow; onDeleted: () => void }) => (
    <div>
      view:{site.name}
      <button type="button" onClick={onDeleted}>
        do-delete
      </button>
    </div>
  ),
}))
jest.mock("./new-site-dialog", () => ({
  NewSiteDialog: ({ onCreated }: { onCreated: (id: string) => void }) => (
    <button type="button" onClick={() => onCreated("brand-new-site")}>
      do-create
    </button>
  ),
}))

import { isTauri } from "@/lib/tauri"
import { useSiteLiveData } from "@/hooks/sites/use-site-live-data"
import { SitesDashboard } from "./sites-dashboard"

const isTauriMock = isTauri as jest.Mock
const useSiteLiveDataMock = useSiteLiveData as jest.Mock

function site(id: string, name: string): SiteProjectRow {
  return {
    id,
    name,
    projectId: "project-1",
    sourceRoot: "/repo",
    sourceSubpath: "docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "account-1", workerName: `${id}-worker` },
    authoringPolicy: { ownerAccountId: "local-user", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
  }
}

function liveData(overrides: Record<string, unknown> = {}) {
  return {
    sites: [],
    selectedId: null,
    versions: [],
    deployments: [],
    environments: [],
    resources: [],
    operations: [],
    events: [],
    loading: false,
    ...overrides,
  }
}

/** Mirror the real hook: resolve the pinned id, else the first site. */
function withSites(sites: SiteProjectRow[]) {
  useSiteLiveDataMock.mockImplementation((pinnedId: string | null) =>
    liveData({ sites, selectedId: pinnedId ?? sites[0]?.id ?? null })
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  useSiteLiveDataMock.mockReturnValue(liveData())
})

it("shows the desktop-only notice outside Tauri", () => {
  isTauriMock.mockReturnValue(false)
  render(<SitesDashboard />)
  expect(screen.getByText("desktopOnly.title")).toBeInTheDocument()
})

it("renders sidebar skeletons while the first snapshot loads", () => {
  useSiteLiveDataMock.mockReturnValue(liveData({ loading: true }))
  const { container } = render(<SitesDashboard />)
  expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
})

it("shows the empty states when no Site exists", () => {
  render(<SitesDashboard />)
  expect(screen.getByText("sidebarEmpty")).toBeInTheDocument()
  expect(screen.getByText("empty")).toBeInTheDocument()
})

it("auto-selects the first Site and renders its publish view", () => {
  withSites([site("site-a", "Site A"), site("site-b", "Site B")])
  render(<SitesDashboard />)
  expect(screen.getByText("view:Site A")).toBeInTheDocument()
})

it("pins the Site the user clicks in the sidebar", () => {
  withSites([site("site-a", "Site A"), site("site-b", "Site B")])
  render(<SitesDashboard />)
  fireEvent.click(screen.getByText("Site B"))
  expect(screen.getByText("view:Site B")).toBeInTheDocument()
})

it("pins a freshly created Site", () => {
  withSites([site("site-a", "Site A")])
  render(<SitesDashboard />)
  fireEvent.click(screen.getByRole("button", { name: "do-create" }))
  expect(useSiteLiveDataMock).toHaveBeenLastCalledWith("brand-new-site")
})

it("clears the selection after the publish view deletes its Site", () => {
  withSites([site("site-a", "Site A")])
  render(<SitesDashboard />)
  fireEvent.click(screen.getByRole("button", { name: "do-delete" }))
  expect(useSiteLiveDataMock).toHaveBeenLastCalledWith(null)
})
