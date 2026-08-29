import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import type { SiteDeploymentRow, SiteProjectRow } from "@/types/sites"
import { SiteMobileOverview } from "./site-mobile-overview"

function site(overrides: Partial<SiteProjectRow> = {}): SiteProjectRow {
  return {
    id: "site_1",
    name: "Docs",
    projectId: "project_1",
    sourceRoot: "/repo",
    sourceSubpath: "",
    executionTarget: { kind: "local" },
    executionTargetKey: "local",
    provider: "cloudflare",
    providerConfig: { accountId: "a", workerName: "cognia-docs" },
    authoringPolicy: { ownerAccountId: "o", editorAccountIds: [], deployerAccountIds: [] },
    visitorPolicy: { mode: "private" },
    lifecycle: "active",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const deployment = (over: Partial<SiteDeploymentRow> = {}) =>
  ({
    id: "d1",
    siteId: "site_1",
    versionId: "v1",
    environmentRevisionId: "e1",
    status: "active",
    productionUrl: "https://docs.example.com",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as SiteDeploymentRow

it("always says the device is read-only and why", () => {
  render(<SiteMobileOverview sites={[]} activeDeployments={[]} loading={false} />)
  expect(screen.getByTestId("sites-mobile-notice")).toHaveTextContent("mobile.readOnly")
  expect(screen.getByTestId("sites-mobile-notice")).toHaveTextContent("mobile.explain")
})

it("explains where Sites live rather than showing a bare card", () => {
  // The previous screen was one alert; a reader could not tell whether the
  // feature was missing, broken, or simply elsewhere.
  render(<SiteMobileOverview sites={[]} activeDeployments={[]} loading={false} />)
  expect(screen.getByTestId("sites-mobile-empty")).toHaveTextContent("mobile.emptyExplain")
})

it("lists the Sites this device's own database holds", () => {
  // ADR-0084: the console renders in every shell over whichever local database
  // that shell owns. Nothing here reaches another host.
  render(
    <SiteMobileOverview
      sites={[site(), site({ id: "site_2", name: "Marketing" })]}
      activeDeployments={[]}
      loading={false}
    />
  )
  expect(screen.getByTestId("sites-mobile-row-site_1")).toHaveTextContent("Docs")
  expect(screen.getByTestId("sites-mobile-row-site_2")).toHaveTextContent("Marketing")
})

it("prefers the live URL over the worker name", () => {
  render(<SiteMobileOverview sites={[site()]} activeDeployments={[deployment()]} loading={false} />)
  expect(screen.getByTestId("sites-mobile-row-site_1")).toHaveTextContent(
    "https://docs.example.com"
  )
})

it("falls back to the worker name before anything is deployed", () => {
  render(<SiteMobileOverview sites={[site()]} activeDeployments={[]} loading={false} />)
  expect(screen.getByTestId("sites-mobile-row-site_1")).toHaveTextContent("cognia-docs")
})

it("shows a skeleton while reading, not the empty explanation", () => {
  render(<SiteMobileOverview sites={[]} activeDeployments={[]} loading />)
  expect(screen.getByTestId("sites-mobile-loading")).toBeInTheDocument()
  expect(screen.queryByTestId("sites-mobile-empty")).not.toBeInTheDocument()
})

it("offers no action at all — every one of them needs the desktop", () => {
  render(<SiteMobileOverview sites={[site()]} activeDeployments={[]} loading={false} />)
  expect(screen.queryAllByRole("button")).toHaveLength(0)
})
