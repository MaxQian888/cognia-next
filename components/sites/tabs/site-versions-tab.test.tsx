import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// jsdom reports zero height for the scroll container, so the real virtualizer
// renders nothing. The repo convention is to mock it wholesale and let every
// row through.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 88,
        size: 88,
        end: (index + 1) * 88,
        lane: 0,
      })),
    getTotalSize: () => count * 88,
    measureElement: jest.fn(),
    scrollToIndex: jest.fn(),
  }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: () => "3 minutes ago" }),
  useNow: () => new Date(1_700_000_000_000),
}))

import type { SiteDeploymentRow, SiteResourceRow, SiteVersionRow } from "@/types/sites"
import { SiteVersionsTab } from "./site-versions-tab"

function version(overrides: Partial<SiteVersionRow> & Pick<SiteVersionRow, "id">): SiteVersionRow {
  return {
    siteId: "site_1",
    sequence: 1,
    status: "ready",
    environmentRevisionId: "env_1",
    source: { commitSha: "a3f91c2abc", dirty: false, lockfileDigest: "l", inputDigest: "i" },
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

function deployment(
  overrides: Partial<SiteDeploymentRow> & Pick<SiteDeploymentRow, "id">
): SiteDeploymentRow {
  return {
    siteId: "site_1",
    versionId: "v1",
    environmentRevisionId: "env_1",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function uploadedResource(versionId: string): SiteResourceRow {
  return {
    id: `res_${versionId}`,
    siteId: "site_1",
    provider: "cloudflare",
    kind: "worker-version",
    providerResourceId: `cf_${versionId}`,
    displayName: versionId,
    ownership: "managed",
    status: "active",
    dependencies: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-desktop" as const, title: "Desktop only" }

function renderTab(props: Partial<React.ComponentProps<typeof SiteVersionsTab>> = {}) {
  const onUpload = jest.fn()
  const onDeploy = jest.fn()
  render(
    <SiteVersionsTab
      versions={[version({ id: "v1" })]}
      deployments={[]}
      resources={[]}
      uploadGate={allowed}
      deployGate={allowed}
      isBusy={() => false}
      onUpload={onUpload}
      onDeploy={onDeploy}
      {...props}
    />
  )
  return { onUpload, onDeploy }
}

it("invites a first build when there are no versions", () => {
  renderTab({ versions: [] })
  expect(screen.getByText("versions.empty")).toBeInTheDocument()
})

it("renders building and failed versions, which the old panel hid entirely", () => {
  renderTab({
    versions: [
      version({ id: "v1", sequence: 1, status: "failed", failureMessage: "install failed" }),
      version({ id: "v2", sequence: 2, status: "building" }),
      version({ id: "v3", sequence: 3 }),
    ],
  })
  expect(screen.getByTestId("site-version-v1")).toBeInTheDocument()
  expect(screen.getByTestId("site-version-v2")).toBeInTheDocument()
  expect(screen.getByTestId("site-version-v3")).toBeInTheDocument()
  expect(screen.getByRole("alert")).toHaveTextContent("install failed")
})

it("surfaces a deployment failure message too", () => {
  renderTab({
    deployments: [
      deployment({ id: "d1", versionId: "v1", status: "failed", failureMessage: "cf 500" }),
    ],
  })
  expect(screen.getByRole("alert")).toHaveTextContent("cf 500")
})

it("links each version's deployment URL", () => {
  renderTab({
    deployments: [
      deployment({ id: "d1", versionId: "v1", productionUrl: "https://docs.workers.dev" }),
    ],
  })
  expect(screen.getByRole("link", { name: "https://docs.workers.dev" })).toHaveAttribute(
    "href",
    "https://docs.workers.dev"
  )
})

it("offers upload before an upload exists and deploy afterwards", async () => {
  const user = userEvent.setup()
  const { onUpload } = renderTab()
  await user.click(screen.getByTestId("site-version-upload-v1"))
  expect(onUpload).toHaveBeenCalledWith(expect.objectContaining({ id: "v1" }))
  expect(screen.queryByTestId("site-version-deploy-v1")).not.toBeInTheDocument()
})

it("relabels deploy as rollback once the version already produced a deployment", async () => {
  const user = userEvent.setup()
  const { onDeploy } = renderTab({
    resources: [uploadedResource("v1")],
    deployments: [deployment({ id: "d1", versionId: "v1", status: "superseded" })],
  })
  const button = screen.getByTestId("site-version-deploy-v1")
  expect(button).toHaveTextContent("actions.rollback")
  await user.click(button)
  expect(onDeploy).toHaveBeenCalledWith(expect.objectContaining({ id: "v1" }))
})

it("offers no publish action for a version that is not ready", () => {
  renderTab({ versions: [version({ id: "v1", status: "building" })] })
  expect(screen.queryByTestId("site-version-upload-v1")).not.toBeInTheDocument()
  expect(screen.queryByTestId("site-version-deploy-v1")).not.toBeInTheDocument()
})

it("gates the publish actions with their reason", () => {
  renderTab({ uploadGate: blocked })
  const button = screen.getByTestId("site-version-upload-v1")
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute("title", "Desktop only")
})

it("shows artifact size and file count straight off the version row", () => {
  renderTab({
    versions: [
      version({ id: "v1", artifactDigest: "abc", artifactSize: 4_194_304, artifactFileCount: 128 }),
    ],
  })
  expect(screen.getByText('versions.artifact:{"size":"4.0MB","count":128}')).toBeInTheDocument()
})

it("says there is no artifact when the row predates the denormalized summary", () => {
  // Rows written before Dexie v202 carry only a digest. The backfill covers
  // the ones whose archive still exists; a version whose artifact is already
  // gone honestly has no size to show.
  renderTab({ versions: [version({ id: "v1", artifactDigest: "abc" })] })
  expect(screen.getByText("versions.noArtifact")).toBeInTheDocument()
})

it("filters by status", async () => {
  const user = userEvent.setup()
  renderTab({
    versions: [version({ id: "v1" }), version({ id: "v2", sequence: 2, status: "failed" })],
  })
  await user.click(screen.getByRole("radio", { name: /versions.filter.failed/ }))
  expect(screen.queryByTestId("site-version-v1")).not.toBeInTheDocument()
  expect(screen.getByTestId("site-version-v2")).toBeInTheDocument()
})

it("marks the version currently serving traffic", () => {
  renderTab({
    versions: [version({ id: "v1" }), version({ id: "v2", sequence: 2 })],
    deployments: [deployment({ id: "d1", versionId: "v2" })],
  })
  expect(screen.getByTestId("site-version-v2")).toHaveClass("border-l-success")
  expect(screen.getByTestId("site-version-v1")).not.toHaveClass("border-l-success")
})

it("flags an uncommitted source tree", () => {
  renderTab({
    versions: [
      version({
        id: "v1",
        source: { commitSha: "abc1234", dirty: true, lockfileDigest: "l", inputDigest: "i" },
      }),
    ],
  })
  expect(screen.getByText("versions.dirty")).toBeInTheDocument()
})

it("offers the build log for anything that finished, and not for a build in flight", () => {
  // The output is the only thing that explains a broken build; it used to be
  // reduced to a single Error message on failure and discarded on success.
  renderTab({
    versions: [
      version({ id: "done", sequence: 1 }),
      version({ id: "failing", sequence: 2, status: "failed" }),
      version({ id: "running", sequence: 3, status: "building" }),
    ],
  })
  expect(screen.getByTestId("site-build-log-done")).toBeInTheDocument()
  expect(screen.getByTestId("site-build-log-failing")).toBeInTheDocument()
  expect(screen.queryByTestId("site-build-log-running")).not.toBeInTheDocument()
})
