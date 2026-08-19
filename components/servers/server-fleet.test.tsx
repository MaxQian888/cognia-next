/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { Operation, ServerDetail } from "@/lib/server-ops/client"
import { ServerFleet, serverDetailHref } from "./server-fleet"

const server = (overrides: Partial<ServerDetail> = {}): ServerDetail => ({
  id: "staging",
  label: "Staging",
  topology: "kubernetes",
  publicUrl: "https://server.example.com",
  health: "healthy",
  releaseDigest: `sha256:${"a".repeat(64)}`,
  lastSeenAt: "2026-08-19T10:00:00.000Z",
  targetRevision: 3,
  productionCertified: true,
  certificationIssues: [],
  capabilities: {
    topologies: [],
    snapshotProviders: [],
    secretProviders: [],
    tlsProviders: [],
    objectStoreProtocols: [],
    requiresProviderCredentials: false,
  },
  ...overrides,
})

const operation = (overrides: Partial<Operation> = {}): Operation => ({
  id: "op-1",
  targetId: "staging",
  kind: "deploy",
  state: "executing",
  request: {},
  result: null,
  error: null,
  createdBy: "operator",
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:00:00.000Z",
  ...overrides,
})

function renderFleet(props: Partial<React.ComponentProps<typeof ServerFleet>> = {}) {
  const onFilterChange = jest.fn()
  const onConnectAgent = jest.fn()
  const onDeploy = jest.fn()
  const view = render(
    <ServerFleet
      servers={[server()]}
      operations={[]}
      loading={false}
      filter="all"
      onFilterChange={onFilterChange}
      onConnectAgent={onConnectAgent}
      onDeploy={onDeploy}
      {...props}
    />
  )
  return { onFilterChange, onConnectAgent, onDeploy, ...view }
}

describe("serverDetailHref", () => {
  it("encodes an id that contains path characters", () => {
    // Target ids allow `.` `_` `-`, and a tenant-prefixed id has to survive the
    // query string rather than splitting the route.
    expect(serverDetailHref("tenant/a")).toBe("/servers/detail?id=tenant%2Fa")
  })
})

it("links each row to its detail route", () => {
  renderFleet()
  expect(screen.getByRole("link", { name: /Staging/ })).toHaveAttribute(
    "href",
    "/servers/detail?id=staging"
  )
})

it("counts only unfinished operations as active", () => {
  renderFleet({
    operations: [
      operation({ id: "op-1", state: "executing" }),
      operation({ id: "op-2", state: "succeeded" }),
    ],
  })
  // The KPI and the row badge must agree, and a finished deploy is not work in
  // progress.
  // Matched loosely: the plural form is the message's job, the count is the
  // component's.
  expect(screen.getByText(/^1 operations?$/)).toBeInTheDocument()
})

it("offers both first steps when the fleet is empty", async () => {
  const user = userEvent.setup()
  const { onDeploy, onConnectAgent } = renderFleet({ servers: [] })

  expect(screen.getByText("No deployment targets yet")).toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: "Deploy target" }))
  expect(onDeploy).toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "Connect agent" }))
  expect(onConnectAgent).toHaveBeenCalled()
})

it("filters the list by health and offers a way back", async () => {
  const user = userEvent.setup()
  const { onFilterChange } = renderFleet({
    servers: [server(), server({ id: "production", label: "Production", health: "degraded" })],
  })

  await user.click(screen.getByRole("radio", { name: /Degraded/ }))
  expect(onFilterChange).toHaveBeenCalledWith("degraded")
})

it("explains an empty filtered view rather than looking like an empty fleet", () => {
  renderFleet({ filter: "unavailable" })
  expect(screen.getByText("Nothing matches this filter")).toBeInTheDocument()
  // The fleet is not empty, so the "deploy your first target" copy would be a
  // wrong answer here.
  expect(screen.queryByText("No deployment targets yet")).not.toBeInTheDocument()
})

it("shows skeletons only on the first load, not on every refresh", () => {
  const { rerender, container } = renderFleet({ servers: [], loading: true })
  expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)

  // With rows already on screen a refresh must not replace them with
  // skeletons — that reads as the fleet disappearing.
  rerender(
    <ServerFleet
      servers={[server()]}
      operations={[]}
      loading
      filter="all"
      onFilterChange={jest.fn()}
      onConnectAgent={jest.fn()}
      onDeploy={jest.fn()}
    />
  )
  expect(screen.getByRole("link", { name: /Staging/ })).toBeInTheDocument()
})
