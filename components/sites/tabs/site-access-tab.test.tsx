import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import type { SiteProjectRow } from "@/types/sites"
import { SiteAccessTab } from "./site-access-tab"

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-owner" as const, title: "Owner only" }

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
    providerConfig: { accountId: "acc", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function renderTab(props: Partial<React.ComponentProps<typeof SiteAccessTab>> = {}) {
  const onSave = jest.fn()
  render(
    <SiteAccessTab
      site={site()}
      actorAccountId="owner"
      gate={allowed}
      isBusy={() => false}
      onSave={onSave}
      {...props}
    />
  )
  return { onSave }
}

it("names the actor's role and what it lets them do", () => {
  // `siteRoleCapabilities` had no caller at all before this tab existed.
  renderTab()
  const row = screen.getByTestId("site-your-role")
  expect(row).toHaveTextContent('authoring.yourRole:{"role":"overview.role.owner"}')
  expect(row).toHaveTextContent("capability.manage")
})

it("says plainly that a viewer can do nothing here", () => {
  renderTab({ actorAccountId: "stranger" })
  expect(screen.getByTestId("site-your-role")).toHaveTextContent("authoring.noCapabilities")
})

it("adds an editor and saves the whole policy", async () => {
  // The first production caller of `updateSiteAuthoringPolicy`, which had
  // validation, normalization, and an owner guard but no way to be reached.
  const user = userEvent.setup()
  const { onSave } = renderTab()
  await user.type(screen.getByLabelText("authoring.addEditor"), "teammate")
  await user.click(screen.getByRole("button", { name: /authoring.addEditor/ }))
  await user.click(screen.getByTestId("site-save-authoring"))

  expect(onSave).toHaveBeenCalledWith({
    ownerAccountId: "owner",
    editorAccountIds: ["teammate"],
    deployerAccountIds: [],
  })
})

it("adds on Enter as well as the button", async () => {
  const user = userEvent.setup()
  const { onSave } = renderTab()
  await user.type(screen.getByLabelText("authoring.addDeployer"), "releaser{Enter}")
  await user.click(screen.getByTestId("site-save-authoring"))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ deployerAccountIds: ["releaser"] }))
})

it("refuses a duplicate and refuses to list the owner, who already outranks both", async () => {
  const user = userEvent.setup()
  renderTab({
    site: site({
      authoringPolicy: {
        ownerAccountId: "owner",
        editorAccountIds: ["teammate"],
        deployerAccountIds: [],
      },
    }),
  })
  const field = screen.getByLabelText("authoring.addEditor")

  await user.type(field, "teammate{Enter}")
  await user.clear(field)
  await user.type(field, "owner{Enter}")
  // One chip, from the stored policy — neither attempt added a second.
  expect(screen.getAllByText("teammate")).toHaveLength(1)
  expect(screen.getByTestId("site-save-authoring")).toBeDisabled()
})

it("removes a collaborator", async () => {
  const user = userEvent.setup()
  const { onSave } = renderTab({
    site: site({
      authoringPolicy: {
        ownerAccountId: "owner",
        editorAccountIds: ["teammate", "other"],
        deployerAccountIds: [],
      },
    }),
  })
  await user.click(screen.getByRole("button", { name: 'authoring.remove:{"account":"teammate"}' }))
  await user.click(screen.getByTestId("site-save-authoring"))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ editorAccountIds: ["other"] }))
})

it("keeps save disabled until something actually changed", () => {
  renderTab()
  expect(screen.getByTestId("site-save-authoring")).toBeDisabled()
})

it("disables editing with its reason for anyone but the owner", () => {
  renderTab({ actorAccountId: "stranger", gate: blocked })
  expect(screen.getByLabelText("authoring.addEditor")).toBeDisabled()
  const save = screen.getByTestId("site-save-authoring")
  expect(save).toBeDisabled()
  expect(save).toHaveAttribute("title", "Owner only")
})

it("marks the owner row when it is you", () => {
  renderTab()
  expect(screen.getAllByText("authoring.you").length).toBeGreaterThan(0)
})
