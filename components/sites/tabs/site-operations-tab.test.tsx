import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// The journal and versions list virtualize; jsdom reports zero height, so the
// real virtualizer renders nothing.
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
  useFormatter: () => ({ relativeTime: () => "3 minutes ago", dateTime: () => "12:04:31" }),
  useNow: () => new Date(1_700_000_000_000),
}))
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copy: jest.fn(), copied: false, isCopying: false }),
}))
jest.mock("@/components/observability/time-range-picker", () => ({
  TimeRangePicker: ({ preset, onPreset }: { preset: string; onPreset: (p: string) => void }) => (
    <button type="button" data-testid="time-range" onClick={() => onPreset("1h")}>
      {preset}
    </button>
  ),
}))

import type {
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
  SiteDeploymentRow,
} from "@/types/sites"
import { SiteOperationsTab } from "./site-operations-tab"

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

const operation: SiteOperationRow = {
  id: "op1",
  siteId: "site_1",
  type: "deploy",
  executionTargetKey: "local",
  idempotencyKey: "op1",
  inputDigest: "d",
  status: "succeeded",
  attemptCount: 1,
  createdAt: 1,
  updatedAt: 1,
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-desktop" as const, title: "Desktop only" }

function renderTab(props: Partial<React.ComponentProps<typeof SiteOperationsTab>> = {}) {
  const onQuery = jest.fn()
  const onClearResult = jest.fn()
  const onRefreshOperation = jest.fn()
  const onCancelOperation = jest.fn()
  render(
    <SiteOperationsTab
      site={site()}
      operations={[operation]}
      resources={[]}
      deployments={[]}
      gate={allowed}
      isBusy={() => false}
      result={undefined}
      onQuery={onQuery}
      onClearResult={onClearResult}
      onRefreshOperation={onRefreshOperation}
      onCancelOperation={onCancelOperation}
      {...props}
    />
  )
  return { onQuery, onClearResult, onRefreshOperation, onCancelOperation }
}

it("opens on the operation journal", () => {
  renderTab()
  expect(screen.getByTestId("site-operation-journal")).toBeInTheDocument()
  expect(screen.queryByTestId("site-observability-result")).not.toBeInTheDocument()
})

it("switches to Worker logs and runs a query with the range and errors-only flag", async () => {
  const user = userEvent.setup()
  const { onQuery } = renderTab()
  await user.click(screen.getByRole("radio", { name: "observability.segments.logs" }))
  await user.click(screen.getByLabelText("observability.errorsOnly"))
  await user.click(screen.getByTestId("site-run-logs"))

  expect(onQuery).toHaveBeenCalledWith(expect.objectContaining({ kind: "logs", errorsOnly: true }))
  const [[query]] = onQuery.mock.calls
  expect(typeof query.range.since).toBe("number")
  expect(typeof query.range.until).toBe("number")
})

it("offers no errors-only switch for analytics", async () => {
  const user = userEvent.setup()
  const { onQuery } = renderTab()
  await user.click(screen.getByRole("radio", { name: "observability.segments.analytics" }))
  expect(screen.queryByLabelText("observability.errorsOnly")).not.toBeInTheDocument()
  await user.click(screen.getByTestId("site-run-analytics"))
  expect(onQuery).toHaveBeenCalledWith(expect.objectContaining({ kind: "analytics" }))
})

it("warns that analytics will be Worker-scoped when nothing names a hostname", async () => {
  const user = userEvent.setup()
  renderTab()
  await user.click(screen.getByRole("radio", { name: "observability.segments.analytics" }))
  expect(screen.getByText("observability.noHostname")).toBeInTheDocument()
})

it("names the hostname the query will use once one exists", async () => {
  const user = userEvent.setup()
  renderTab({
    resources: [
      {
        id: "d1",
        siteId: "site_1",
        provider: "cloudflare",
        kind: "custom-domain",
        providerResourceId: "cf",
        displayName: "docs.example.com",
        ownership: "managed",
        status: "active",
        dependencies: [],
        createdAt: 1,
        updatedAt: 1,
      } satisfies SiteResourceRow,
    ],
  })
  await user.click(screen.getByRole("radio", { name: "observability.segments.analytics" }))
  // The line also carries the worker-scoped caveat, so the text is split.
  expect(screen.getByTestId("site-operations-tab")).toHaveTextContent(
    'observability.hostname:{"hostname":"docs.example.com"}'
  )
  expect(screen.getByText("observability.workerScoped", { exact: false })).toBeInTheDocument()
})

it("renders the query result as a tree rather than a stringified blob", async () => {
  const user = userEvent.setup()
  renderTab({ result: { requests: 42 } })
  await user.click(screen.getByRole("radio", { name: "observability.segments.logs" }))
  const output = screen.getByTestId("site-observability-result")
  expect(output).toHaveTextContent("requests")
  expect(output).toHaveTextContent("42")
})

it("clears the result", async () => {
  const user = userEvent.setup()
  const { onClearResult } = renderTab({ result: { a: 1 } })
  await user.click(screen.getByRole("radio", { name: "observability.segments.logs" }))
  await user.click(screen.getByText("actions.clearOutput"))
  expect(onClearResult).toHaveBeenCalled()
})

it("gates the provider queries", async () => {
  const user = userEvent.setup()
  renderTab({ gate: blocked })
  await user.click(screen.getByRole("radio", { name: "observability.segments.logs" }))
  const button = screen.getByTestId("site-run-logs")
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute("title", "Desktop only")
})

it("passes the re-check through to the journal", async () => {
  const user = userEvent.setup()
  const { onRefreshOperation } = renderTab({
    operations: [{ ...operation, status: "waiting-reconcile" }],
  })
  await user.click(screen.getByTestId("site-operation-op1"))
  await user.click(screen.getByRole("button", { name: /actions.refreshOperation/ }))
  expect(onRefreshOperation).toHaveBeenCalledWith("op1")
})

it("shows a deployment host when no custom domain exists", async () => {
  const user = userEvent.setup()
  renderTab({
    deployments: [
      {
        id: "dep",
        siteId: "site_1",
        versionId: "v1",
        environmentRevisionId: "env",
        status: "active",
        productionUrl: "https://docs.workers.dev",
        createdAt: 1,
        updatedAt: 1,
      } satisfies SiteDeploymentRow,
    ],
  })
  await user.click(screen.getByRole("radio", { name: "observability.segments.analytics" }))
  expect(screen.getByTestId("site-operations-tab")).toHaveTextContent(
    'observability.hostname:{"hostname":"docs.workers.dev"}'
  )
})

it("passes the abandon action through to the journal", async () => {
  const user = userEvent.setup()
  const { onCancelOperation } = renderTab({
    operations: [{ ...operation, status: "waiting-reconcile" }],
  })
  await user.click(screen.getByTestId("site-operation-op1"))
  await user.click(screen.getByTestId("site-operation-cancel-op1"))
  expect(onCancelOperation).toHaveBeenCalledWith("op1")
})
