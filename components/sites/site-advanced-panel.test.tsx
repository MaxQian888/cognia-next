import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SiteProjectRow, SiteResourceRow, SiteVisitorPolicy } from "@/types/sites"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))
jest.mock("@/lib/db/sites", () => ({ updateSiteAuthoringPolicy: jest.fn() }))

import { updateSiteAuthoringPolicy } from "@/lib/db/sites"
import { SiteAdvancedPanel } from "./site-advanced-panel"

const updateAuthoringMock = updateSiteAuthoringPolicy as jest.Mock

const SITE: SiteProjectRow = {
  id: "site-1",
  name: "Docs",
  projectId: "project-1",
  sourceRoot: "/repo",
  sourceSubpath: "docs",
  executionTarget: { kind: "local" },
  executionTargetKey: "local",
  provider: "cloudflare",
  providerConfig: { accountId: "account-1", workerName: "docs-worker" },
  authoringPolicy: { ownerAccountId: "owner", editorAccountIds: ["ed-1"], deployerAccountIds: [] },
  visitorPolicy: { mode: "private" },
  lifecycle: "active",
  createdAt: 1,
  updatedAt: 1,
}

const DOMAIN_RESOURCE: SiteResourceRow = {
  id: "res-domain",
  siteId: "site-1",
  provider: "cloudflare",
  kind: "custom-domain",
  providerResourceId: "cf-domain",
  displayName: "docs.example.com",
  ownership: "managed",
  status: "active",
  dependencies: [],
  createdAt: 1,
  updatedAt: 1,
}

function makeService() {
  return {
    reconcileVisitorAccess: jest.fn(async () => undefined),
    addDomain: jest.fn(async () => undefined),
    removeDomain: jest.fn(async () => undefined),
    saveProviderToken: jest.fn(async () => undefined),
    reconcile: jest.fn(async () => ({ resolved: 0, remaining: 0 })),
    logs: jest.fn(async () => ({ events: [] })),
    analytics: jest.fn(async () => ({ requests: 1 })),
  }
}

async function renderOpen(overrides: Partial<React.ComponentProps<typeof SiteAdvancedPanel>> = {}) {
  const user = userEvent.setup()
  const service = makeService()
  const act = jest.fn(async (_key: string, action: () => Promise<void>) => {
    await action()
  })
  render(
    <SiteAdvancedPanel
      key={SITE.id}
      site={SITE}
      resources={[DOMAIN_RESOURCE]}
      operations={[
        {
          id: "op-1",
          siteId: "site-1",
          type: "deploy",
          executionTargetKey: "local",
          idempotencyKey: "k",
          inputDigest: "d",
          status: "succeeded",
          attemptCount: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ]}
      events={[{ id: "e1", operationId: "op-1", sequence: 1, type: "succeeded", createdAt: 2 }]}
      service={() => service as never}
      actorAccountId="owner"
      busy={null}
      act={act}
      {...overrides}
    />
  )
  await user.click(screen.getByRole("button", { name: "advanced.title" }))
  return { user, service, act }
}

beforeEach(() => jest.clearAllMocks())

it("compiles each visitor access mode into the right policy shape", async () => {
  const { service } = await renderOpen()
  fireEvent.change(screen.getByPlaceholderText("access.hostname"), {
    target: { value: "docs.example.com" },
  })
  const cases: { mode: SiteVisitorPolicy["mode"]; values: string; expected: SiteVisitorPolicy }[] =
    [
      { mode: "private", values: "", expected: { mode: "private" } },
      {
        mode: "identities",
        values: "a@b.com",
        expected: { mode: "identities", emails: ["a@b.com"] },
      },
      { mode: "domains", values: "b.com", expected: { mode: "domains", domains: ["b.com"] } },
      {
        mode: "organization",
        values: "org-1",
        expected: { mode: "organization", organizationId: "org-1" },
      },
    ]
  for (const testCase of cases) {
    service.reconcileVisitorAccess.mockClear()
    fireEvent.change(screen.getByLabelText("access.mode"), { target: { value: testCase.mode } })
    fireEvent.change(screen.getByPlaceholderText("access.values"), {
      target: { value: testCase.values },
    })
    fireEvent.click(screen.getByRole("button", { name: "actions.saveAccess" }))
    await screen.findByRole("button", { name: "actions.saveAccess" })
    expect(service.reconcileVisitorAccess).toHaveBeenLastCalledWith(
      "site-1",
      testCase.expected,
      "docs.example.com"
    )
  }
})

it("adds and removes custom domains", async () => {
  const { service } = await renderOpen()
  fireEvent.change(screen.getByPlaceholderText("domains.hostname"), {
    target: { value: "new.example.com" },
  })
  fireEvent.click(screen.getByRole("button", { name: "actions.addDomain" }))
  await screen.findByText("docs.example.com")
  expect(service.addDomain).toHaveBeenCalledWith("site-1", "new.example.com")

  fireEvent.click(screen.getByRole("button", { name: "actions.remove" }))
  expect(service.removeDomain).toHaveBeenCalledWith("site-1", "res-domain")
})

it("reconciles provider state and shows account + worker info", async () => {
  const { service } = await renderOpen()
  expect(screen.getByText(/provider.account/)).toHaveTextContent("account-1")
  expect(screen.getByText(/provider.worker/)).toHaveTextContent("docs-worker")

  fireEvent.click(screen.getByRole("button", { name: "actions.reconcile" }))
  await screen.findByRole("button", { name: "actions.reconcile" })
  expect(service.reconcile).toHaveBeenCalledWith("site-1")
})

it("saves the authoring policy from the edited fields", async () => {
  await renderOpen()
  const authoringFields = screen.getAllByPlaceholderText("authoring.accountsPlaceholder")
  fireEvent.change(authoringFields[0], { target: { value: "ed-1\ned-2" } })
  fireEvent.change(authoringFields[1], { target: { value: "dep-1" } })
  fireEvent.click(screen.getByRole("button", { name: "actions.saveAuthoring" }))
  await screen.findByRole("button", { name: "actions.saveAuthoring" })
  expect(updateAuthoringMock).toHaveBeenCalledWith("site-1", "owner", {
    ownerAccountId: "owner",
    editorAccountIds: ["ed-1", "ed-2"],
    deployerAccountIds: ["dep-1"],
  })
})

it("queries provider logs and analytics", async () => {
  const { service } = await renderOpen()
  fireEvent.click(screen.getByRole("button", { name: "actions.loadLogs" }))
  await screen.findByRole("button", { name: "actions.loadLogs" })
  expect(service.logs).toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "actions.loadAnalytics" }))
  await screen.findByRole("button", { name: "actions.loadAnalytics" })
  expect(service.analytics).toHaveBeenCalled()
})

it("renders the durable operation journal with event counts", async () => {
  await renderOpen()
  expect(screen.getByText("operationType.deploy")).toBeInTheDocument()
  expect(screen.getByText(/operations.eventCount/)).toHaveTextContent('"count":1')
})

it("shows the empty journal state when there are no operations", async () => {
  await renderOpen({ operations: [], events: [] })
  expect(screen.getByText("operations.empty")).toBeInTheDocument()
})
