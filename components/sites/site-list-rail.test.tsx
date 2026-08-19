import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useFormatter: () => ({ relativeTime: () => "3 minutes ago" }),
  useNow: () => new Date(1_700_000_000_000),
}))

import type { SiteDeploymentRow, SiteOperationRow, SiteProjectRow } from "@/types/sites"
import { SiteListRail } from "./site-list-rail"

function site(overrides: Partial<SiteProjectRow> & Pick<SiteProjectRow, "id">): SiteProjectRow {
  return {
    name: overrides.id,
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "apps/docs",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "account", workerName: `${overrides.id}-worker` },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function deployment(siteId: string): SiteDeploymentRow {
  return {
    id: `dep_${siteId}`,
    siteId,
    versionId: "v1",
    environmentRevisionId: "env_1",
    status: "active",
    createdAt: 1,
    updatedAt: 50,
  }
}

function operation(siteId: string, status: SiteOperationRow["status"]): SiteOperationRow {
  return {
    id: `op_${siteId}`,
    siteId,
    type: "build",
    executionTargetKey: "local",
    idempotencyKey: `op_${siteId}`,
    inputDigest: "d",
    status,
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

function renderRail(props: Partial<React.ComponentProps<typeof SiteListRail>> = {}) {
  const onSelect = jest.fn()
  render(
    <SiteListRail
      sites={[site({ id: "docs" }), site({ id: "marketing" })]}
      selectedId="docs"
      loading={false}
      activeDeployments={[]}
      operationSignals={[]}
      onSelect={onSelect}
      {...props}
    />
  )
  return { onSelect }
}

it("shows skeletons before the first snapshot", () => {
  renderRail({ loading: true, sites: [] })
  expect(
    screen.getByTestId("site-rail-list").querySelectorAll('[data-slot="skeleton"]')
  ).toHaveLength(3)
})

it("invites the first Site when there are none", () => {
  renderRail({ sites: [] })
  expect(screen.getByText("sidebarEmpty")).toBeInTheDocument()
})

it("marks the selection and reports clicks", async () => {
  const user = userEvent.setup()
  const { onSelect } = renderRail()
  expect(screen.getByTestId("site-rail-row-docs")).toHaveAttribute("aria-current", "true")
  expect(screen.getByTestId("site-rail-row-marketing")).not.toHaveAttribute("aria-current")

  await user.click(screen.getByTestId("site-rail-row-marketing"))
  expect(onSelect).toHaveBeenCalledWith("marketing")
})

it("derives a per-row hint from the cross-Site signals", () => {
  renderRail({
    activeDeployments: [deployment("docs")],
    operationSignals: [operation("marketing", "running")],
  })
  expect(screen.getByTestId("site-rail-row-docs")).toHaveTextContent("rail.hint.live")
  expect(screen.getByTestId("site-rail-row-marketing")).toHaveTextContent("rail.running")
})

it("shows a never-published Site as such", () => {
  renderRail()
  expect(screen.getByTestId("site-rail-row-docs")).toHaveTextContent("rail.hint.never")
})

it("filters by name and by worker name", async () => {
  const user = userEvent.setup()
  renderRail()
  await user.type(screen.getByLabelText("rail.search"), "marketing-worker")
  expect(screen.queryByTestId("site-rail-row-docs")).not.toBeInTheDocument()
  expect(screen.getByTestId("site-rail-row-marketing")).toBeInTheDocument()
})

it("says so when the search matches nothing", async () => {
  const user = userEvent.setup()
  renderRail()
  await user.type(screen.getByLabelText("rail.search"), "zzz")
  expect(screen.getByText("rail.noMatches")).toBeInTheDocument()
})

it("filters by lifecycle", async () => {
  const user = userEvent.setup()
  renderRail({
    sites: [site({ id: "docs" }), site({ id: "old", lifecycle: "taken-down" })],
  })
  await user.click(screen.getByRole("radio", { name: /lifecycle.taken-down/ }))
  expect(screen.queryByTestId("site-rail-row-docs")).not.toBeInTheDocument()
  expect(screen.getByTestId("site-rail-row-old")).toBeInTheDocument()
})

it("counts live, taken-down, and busy Sites in the footer", () => {
  renderRail({
    sites: [
      site({ id: "docs" }),
      site({ id: "old", lifecycle: "taken-down" }),
      site({ id: "busy" }),
    ],
    operationSignals: [operation("busy", "queued")],
  })
  const footer = screen.getByTestId("site-rail").lastElementChild as HTMLElement
  expect(footer).toHaveTextContent("2")
  expect(footer).toHaveTextContent("1")
})

it("renders the creation footer the console supplies", () => {
  renderRail({ footer: <button type="button">create</button> })
  expect(screen.getByRole("button", { name: "create" })).toBeInTheDocument()
})
