import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import type { SiteProjectRow, SiteResourceRow } from "@/types/sites"
import { SiteDomainsTab } from "./site-domains-tab"

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
    providerConfig: { accountId: "account_1", workerName: "docs" },
    authoringPolicy: { ownerAccountId: "owner", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function domain(id: string, hostname: string): SiteResourceRow {
  return {
    id,
    siteId: "site_1",
    provider: "cloudflare",
    kind: "custom-domain",
    providerResourceId: `cf_${id}`,
    displayName: hostname,
    ownership: "managed",
    status: "active",
    dependencies: [],
    createdAt: 1,
    updatedAt: 1,
  }
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-owner" as const, title: "Owner only" }

function renderTab(props: Partial<React.ComponentProps<typeof SiteDomainsTab>> = {}) {
  const handlers = {
    onAddDomain: jest.fn(),
    onRemoveDomain: jest.fn(),
    onSaveProviderConfig: jest.fn(),
    onApplyAccess: jest.fn(),
  }
  render(
    <SiteDomainsTab
      site={site()}
      resources={[]}
      gate={allowed}
      isBusy={() => false}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

it("blocks add-domain and says why when no zone id is stored", async () => {
  const user = userEvent.setup()
  const handlers = renderTab()
  await user.type(screen.getByLabelText("domains.title"), "docs.example.com")

  const button = screen.getByTestId("site-add-domain")
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute("title", "provider.zoneIdRequired")
  expect(screen.getByTestId("site-zone-missing")).toBeInTheDocument()
  expect(handlers.onAddDomain).not.toHaveBeenCalled()
})

it("adds a domain once a zone id exists", async () => {
  const user = userEvent.setup()
  const handlers = renderTab({
    site: site({ providerConfig: { accountId: "a", workerName: "w", zoneId: "zone_1" } }),
  })
  await user.type(screen.getByLabelText("domains.title"), "docs.example.com")
  await user.click(screen.getByTestId("site-add-domain"))
  expect(handlers.onAddDomain).toHaveBeenCalledWith("docs.example.com")
})

it("saves the provider fields that had no UI at all", async () => {
  const user = userEvent.setup()
  const handlers = renderTab()
  await user.type(screen.getByLabelText("provider.zoneId"), "zone_1")
  await user.type(screen.getByLabelText("provider.accessTeamName"), "acme")
  await user.click(screen.getByTestId("site-save-provider-config"))
  expect(handlers.onSaveProviderConfig).toHaveBeenCalledWith({
    zoneId: "zone_1",
    accessTeamName: "acme",
  })
})

it("shows the account and worker as fixed identity", () => {
  renderTab()
  expect(screen.getByText("account_1")).toBeInTheDocument()
  expect(screen.getByText("docs")).toBeInTheDocument()
  expect(screen.getByText("provider.identityLocked")).toBeInTheDocument()
})

it("lists attached domains", () => {
  renderTab({ resources: [domain("r1", "docs.example.com")] })
  expect(screen.getByTestId("site-domain-r1")).toHaveTextContent("docs.example.com")
})

it("asks before detaching a domain, and names the hostname it would take", async () => {
  // Detaching stops the Site routing on that hostname at the provider; there
  // is no undo but re-adding it. It used to fire on the first click.
  const user = userEvent.setup()
  const handlers = renderTab({ resources: [domain("r1", "docs.example.com")] })
  await user.click(screen.getByTestId("site-domain-remove-r1"))
  expect(handlers.onRemoveDomain).not.toHaveBeenCalled()
  const dialog = await screen.findByRole("alertdialog")
  expect(dialog).toHaveTextContent("docs.example.com")
  expect(dialog).toHaveTextContent("confirm.removeDomain.title")

  await user.click(within(dialog).getByText("actions.remove"))
  expect(handlers.onRemoveDomain).toHaveBeenCalledWith("r1")
})

it("leaves the domain attached when the confirmation is dismissed", async () => {
  const user = userEvent.setup()
  const handlers = renderTab({ resources: [domain("r1", "docs.example.com")] })
  await user.click(screen.getByTestId("site-domain-remove-r1"))
  await user.click(screen.getByText("actions.cancel"))
  expect(handlers.onRemoveDomain).not.toHaveBeenCalled()
})

it("seeds the access editor from the stored policy so re-applying cannot wipe it", async () => {
  const user = userEvent.setup()
  const handlers = renderTab({
    site: site({ visitorPolicy: { mode: "identities", emails: ["a@example.com", "b@corp.io"] } }),
  })

  expect(screen.getByLabelText("access.values")).toHaveValue("a@example.com\nb@corp.io")

  await user.click(screen.getByTestId("site-apply-access"))
  expect(handlers.onApplyAccess).toHaveBeenCalledWith(
    { mode: "identities", emails: ["a@example.com", "b@corp.io"] },
    ""
  )
})

it("compiles each access mode into the right policy shape", async () => {
  const user = userEvent.setup()
  const handlers = renderTab()

  await user.click(screen.getByRole("radio", { name: /access.modes.domains/ }))
  await user.type(screen.getByLabelText("access.values"), "example.com")
  await user.click(screen.getByTestId("site-apply-access"))
  expect(handlers.onApplyAccess).toHaveBeenLastCalledWith(
    { mode: "domains", domains: ["example.com"] },
    ""
  )

  await user.click(screen.getByRole("radio", { name: /access.modes.organization/ }))
  await user.type(screen.getByLabelText("access.values"), "org_1")
  await user.click(screen.getByTestId("site-apply-access"))
  expect(handlers.onApplyAccess).toHaveBeenLastCalledWith(
    { mode: "organization", organizationId: "org_1" },
    ""
  )

  await user.click(screen.getByRole("radio", { name: /access.modes.public/ }))
  await user.click(screen.getByTestId("site-apply-access"))
  expect(handlers.onApplyAccess).toHaveBeenLastCalledWith({ mode: "public" }, "")
})

it("hides the value editor for the modes that take no values", async () => {
  const user = userEvent.setup()
  renderTab()
  expect(screen.queryByLabelText("access.values")).not.toBeInTheDocument()
  await user.click(screen.getByRole("radio", { name: /access.modes.identities/ }))
  expect(screen.getByLabelText("access.values")).toBeInTheDocument()
})

it("passes the protected hostname through with the policy", async () => {
  const user = userEvent.setup()
  const handlers = renderTab()
  await user.type(screen.getByLabelText("access.hostname"), "docs.example.com")
  await user.click(screen.getByTestId("site-apply-access"))
  expect(handlers.onApplyAccess).toHaveBeenCalledWith({ mode: "private" }, "docs.example.com")
})

it("gates every mutation with its reason", () => {
  renderTab({
    gate: blocked,
    site: site({ providerConfig: { accountId: "a", workerName: "w", zoneId: "z" } }),
  })
  expect(screen.getByTestId("site-save-provider-config")).toBeDisabled()
  expect(screen.getByTestId("site-apply-access")).toHaveAttribute("title", "Owner only")
})

describe("Access sign-in origin", () => {
  it("links to the team domain for a protected Site", () => {
    renderTab({
      site: site({
        providerConfig: { accountId: "a", workerName: "w", accessTeamName: "acme" },
      }),
    })
    const link = screen.getByRole("link", { name: /cloudflareaccess\.com/ })
    expect(link).toHaveAttribute("href", "https://acme.cloudflareaccess.com")
  })

  it("accepts a full team domain as well as a bare name", () => {
    renderTab({
      site: site({
        providerConfig: {
          accountId: "a",
          workerName: "w",
          accessTeamName: "acme.cloudflareaccess.com",
        },
      }),
    })
    expect(screen.getByRole("link", { name: /acme/ })).toHaveAttribute(
      "href",
      "https://acme.cloudflareaccess.com"
    )
  })

  it("asks for the team name when a protected Site has none", () => {
    renderTab()
    expect(screen.getByTestId("site-access-team-missing")).toBeInTheDocument()
  })

  it("says nothing for a public Site, which has no sign-in step", () => {
    renderTab({ site: site({ visitorPolicy: { mode: "public" } }) })
    expect(screen.queryByTestId("site-access-login")).not.toBeInTheDocument()
  })
})
