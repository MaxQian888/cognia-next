import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: () => "3 minutes ago" }),
  useNow: () => new Date(1_700_000_000_000),
}))

const copy = jest.fn(async () => true)
jest.mock("@/hooks/ui", () => ({ useCopy: () => ({ copy, copied: false, isCopying: false }) }))

import type {
  SiteDeploymentRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteVersionRow,
} from "@/types/sites"
import { SiteOverviewHeader } from "./site-overview-header"

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
    providerConfig: { accountId: "account", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function version(overrides: Partial<SiteVersionRow> = {}): SiteVersionRow {
  return {
    id: "v1",
    siteId: "site_1",
    sequence: 12,
    status: "ready",
    environmentRevisionId: "env_1",
    source: { commitSha: "a3f91c2abcdef", dirty: false, lockfileDigest: "l", inputDigest: "i" },
    build: {
      command: "[]",
      runtime: "node@24",
      packageManager: "pnpm@10",
      compatibilityDate: "2026-08-19",
      compatibilityFlags: [],
      routes: [],
      bindings: [],
    },
    createdAt: 1,
    ...overrides,
  }
}

function deployment(overrides: Partial<SiteDeploymentRow> = {}): SiteDeploymentRow {
  return {
    id: "dep_1",
    siteId: "site_1",
    versionId: "v1",
    environmentRevisionId: "env_1",
    status: "active",
    productionUrl: "https://docs.workers.dev",
    createdAt: 1,
    updatedAt: 50,
    ...overrides,
  }
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-desktop" as const, title: "Desktop only" }

function renderHeader(props: Partial<React.ComponentProps<typeof SiteOverviewHeader>> = {}) {
  const handlers = {
    onTakeDown: jest.fn(),
    onRestore: jest.fn(),
    onPurge: jest.fn(),
    onDeleteMetadata: jest.fn(),
  }
  render(
    <SiteOverviewHeader
      site={site()}
      versions={[version()]}
      deployments={[deployment()]}
      operations={[]}
      actorAccountId="owner"
      gate={allowed}
      metadataGate={allowed}
      busy={false}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

beforeEach(() => {
  jest.clearAllMocks()
})

it("renders the production URL as an openable, copyable link", async () => {
  const user = userEvent.setup()
  renderHeader()

  const link = screen.getByTestId("site-production-url")
  expect(link).toHaveAttribute("href", "https://docs.workers.dev")
  expect(screen.getByRole("link", { name: "actions.openSite" })).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: "actions.copyUrl" }))
  expect(copy).toHaveBeenCalledWith("https://docs.workers.dev")
})

it("holds the URL slot with an explanation before the first deploy", () => {
  renderHeader({ deployments: [] })
  expect(screen.queryByTestId("site-production-url")).not.toBeInTheDocument()
  expect(screen.getByText("overview.noProductionUrl")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "actions.copyUrl" })).toBeDisabled()
})

it("names the live version, its commit, and when it went out", () => {
  renderHeader()
  expect(screen.getByText('overview.currentVersion:{"sequence":12}')).toBeInTheDocument()
  expect(screen.getByText("a3f91c2")).toBeInTheDocument()
  expect(screen.getByText(/overview.deployedAt/)).toBeInTheDocument()
})

it("flags an uncommitted source tree on the live version", () => {
  renderHeader({ versions: [version({ source: { ...version().source, dirty: true } })] })
  expect(screen.getByText("versions.dirty")).toBeInTheDocument()
})

it("shows the owner and the viewer's own role", () => {
  renderHeader({ actorAccountId: "stranger" })
  expect(screen.getByText("owner")).toBeInTheDocument()
  expect(screen.getByText(/overview.role.viewer/)).toBeInTheDocument()
})

it("surfaces unresolved failures that used to vanish with the toast", () => {
  renderHeader({
    versions: [version({ status: "failed", failureMessage: "install failed" })],
    deployments: [],
    operations: [
      {
        id: "op1",
        siteId: "site_1",
        type: "upload",
        executionTargetKey: "local",
        idempotencyKey: "op1",
        inputDigest: "d",
        status: "failed",
        errorMessage: "wrangler exited 1",
        attemptCount: 2,
        createdAt: 1,
        updatedAt: 2,
      } satisfies SiteOperationRow,
    ],
  })
  const banner = screen.getByTestId("site-failure-banner")
  expect(banner).toHaveTextContent("install failed")
  expect(banner).toHaveTextContent("wrangler exited 1")
  expect(screen.getByText('overview.needsAttention:{"count":2}')).toBeInTheDocument()
})

it("hides the banner when nothing is broken", () => {
  renderHeader()
  expect(screen.queryByTestId("site-failure-banner")).not.toBeInTheDocument()
})

it("offers exactly the lifecycle actions the current state allows", async () => {
  const user = userEvent.setup()
  const handlers = renderHeader()
  await user.click(screen.getByTestId("site-take-down"))
  expect(handlers.onTakeDown).toHaveBeenCalled()
  expect(screen.queryByTestId("site-restore")).not.toBeInTheDocument()
  expect(screen.queryByTestId("site-purge")).not.toBeInTheDocument()
})

it("offers restore and purge once taken down, and metadata deletion once deleted", async () => {
  const user = userEvent.setup()
  const handlers = renderHeader({ site: site({ lifecycle: "taken-down" }) })
  await user.click(screen.getByTestId("site-restore"))
  await user.click(screen.getByTestId("site-purge"))
  expect(handlers.onRestore).toHaveBeenCalled()
  expect(handlers.onPurge).toHaveBeenCalled()
})

it("shows no lifecycle action while the Site is being deleted", () => {
  renderHeader({ site: site({ lifecycle: "deleting" }) })
  expect(screen.queryByTestId("site-take-down")).not.toBeInTheDocument()
  expect(screen.queryByTestId("site-delete-metadata")).not.toBeInTheDocument()
})

it("gates provider lifecycle actions but keeps metadata deletion on its own gate", () => {
  renderHeader({ site: site({ lifecycle: "taken-down" }), gate: blocked })
  expect(screen.getByTestId("site-restore")).toBeDisabled()
  expect(screen.getByTestId("site-restore")).toHaveAttribute("title", "Desktop only")

  render(
    <SiteOverviewHeader
      site={site({ lifecycle: "deleted" })}
      versions={[]}
      deployments={[]}
      operations={[]}
      actorAccountId="owner"
      gate={blocked}
      metadataGate={allowed}
      busy={false}
      onTakeDown={jest.fn()}
      onRestore={jest.fn()}
      onPurge={jest.fn()}
      onDeleteMetadata={jest.fn()}
    />
  )
  expect(screen.getByTestId("site-delete-metadata")).toBeEnabled()
})
