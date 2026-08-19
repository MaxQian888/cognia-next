import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import type { SiteResourceKind, SiteResourceRow } from "@/types/sites"
import { SiteResourcesTab } from "./site-resources-tab"

function resource(
  overrides: Partial<SiteResourceRow> & Pick<SiteResourceRow, "id" | "kind">
): SiteResourceRow {
  return {
    siteId: "site_1",
    provider: "cloudflare",
    providerResourceId: `cf_${overrides.id}`,
    ownership: "managed",
    status: "active",
    dependencies: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const allowed = { allowed: true, reason: "ok" as const, title: undefined }
const blocked = { allowed: false, reason: "requires-desktop" as const, title: "Desktop only" }

function renderTab(props: Partial<React.ComponentProps<typeof SiteResourcesTab>> = {}) {
  const onReconcile = jest.fn()
  render(
    <SiteResourcesTab
      resources={[resource({ id: "w1", kind: "worker", displayName: "docs" })]}
      gate={allowed}
      busy={false}
      onReconcile={onReconcile}
      {...props}
    />
  )
  return { onReconcile }
}

it("says so when nothing has been provisioned", () => {
  renderTab({ resources: [] })
  expect(screen.getByTestId("site-resources-empty")).toBeInTheDocument()
})

it("renders all eight resource kinds, not just custom domains", () => {
  const kinds: SiteResourceKind[] = [
    "worker",
    "worker-version",
    "d1-database",
    "r2-bucket",
    "custom-domain",
    "access-application",
    "access-policy",
    "secret",
  ]
  renderTab({
    resources: kinds.map((kind, index) => resource({ id: `r${index}`, kind })),
  })
  for (const kind of kinds) {
    expect(screen.getByTestId(`site-resource-group-${kind}`)).toBeInTheDocument()
  }
})

it("gives ownership its own channel, in a colour that is not the failure colour", () => {
  renderTab({
    resources: [
      resource({ id: "m", kind: "worker", ownership: "managed" }),
      resource({ id: "a", kind: "d1-database", ownership: "adopted" }),
      resource({ id: "s", kind: "r2-bucket", ownership: "shared" }),
    ],
  })
  expect(screen.getByTestId("site-resource-m")).toHaveClass("border-l-warning/70")
  expect(screen.getByTestId("site-resource-a")).toHaveClass("border-l-border")
  expect(screen.getByTestId("site-resource-s")).toHaveClass("border-l-info/60")
  expect(screen.getByTestId("site-resource-m")).not.toHaveClass("border-l-destructive")
})

it("labels each ownership with what a purge does to it", () => {
  renderTab({
    resources: [
      resource({ id: "m", kind: "worker", ownership: "managed" }),
      resource({ id: "a", kind: "d1-database", ownership: "adopted" }),
    ],
  })
  expect(screen.getByText("resources.ownershipHint.managed")).toBeInTheDocument()
  expect(screen.getByText("resources.ownershipHint.adopted")).toBeInTheDocument()
})

it("reports the purge scope before anyone presses purge", () => {
  renderTab({
    resources: [
      resource({ id: "m1", kind: "worker", ownership: "managed" }),
      resource({ id: "m2", kind: "secret", ownership: "managed" }),
      resource({ id: "a1", kind: "d1-database", ownership: "adopted" }),
      resource({ id: "gone", kind: "r2-bucket", ownership: "managed", status: "deleted" }),
    ],
  })
  expect(screen.getByTestId("site-purge-scope-deleted")).toHaveTextContent(
    'resources.retention.purgeable:{"count":2}'
  )
  expect(screen.getByTestId("site-purge-scope-retained")).toHaveTextContent(
    'resources.retention.retained:{"count":1}'
  )
})

it("shows dependency counts and resource status", () => {
  renderTab({
    resources: [resource({ id: "s1", kind: "secret", dependencies: ["w1"], status: "orphaned" })],
  })
  expect(screen.getByText('resources.dependencies:{"count":1}')).toBeInTheDocument()
  expect(screen.getByText("resources.status.orphaned")).toBeInTheDocument()
})

it("dims resources the provider no longer has", () => {
  renderTab({ resources: [resource({ id: "d1", kind: "worker", status: "deleted" })] })
  expect(screen.getByTestId("site-resource-d1")).toHaveClass("opacity-60")
})

it("reconciles provider state, gated", async () => {
  const user = userEvent.setup()
  const { onReconcile } = renderTab()
  await user.click(screen.getByTestId("site-reconcile"))
  expect(onReconcile).toHaveBeenCalled()

  renderTab({ gate: blocked })
  const buttons = screen.getAllByTestId("site-reconcile")
  expect(buttons[buttons.length - 1]).toBeDisabled()
})
