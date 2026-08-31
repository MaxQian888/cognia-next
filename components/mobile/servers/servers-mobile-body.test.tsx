/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

jest.mock("@/components/servers/deployment-wizard", () => ({
  DeploymentWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="deployment-wizard" /> : null,
}))
jest.mock("@/components/servers/connect-agent-dialog", () => ({
  ConnectAgentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="connect-agent-dialog" /> : null,
}))
jest.mock("@/components/servers/operation-inspector", () => ({
  OperationInspector: () => null,
}))
jest.mock("@/components/servers/ops-connect-panel", () => ({
  OpsConnectPanel: () => <div data-testid="ops-connect-panel" />,
}))
jest.mock("@/components/servers/server-fleet", () => ({
  ServerFleet: () => <div data-testid="server-fleet" />,
}))
jest.mock("@/components/servers/operations-rail", () => ({
  OperationsRail: () => <div data-testid="operations-rail" />,
}))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// eslint-disable-next-line no-var -- jest.mock factories hoist above this body.
var opsState: Record<string, unknown>
jest.mock("@/components/servers/ops-context", () => ({
  useServerOps: () => opsState,
}))

import { ServersMobileBody } from "./servers-mobile-body"

function ops(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "acc-1",
    connected: true,
    connection: { controllerUrl: "https://ops.example.com", profileId: "prod" },
    servers: [],
    operations: [],
    liveEvents: true,
    eventStreamConnected: true,
    loading: false,
    offline: false,
    refresh: jest.fn(),
    disconnect: jest.fn(),
    registerAndDeploy: jest.fn(),
    createEnrollmentToken: jest.fn(),
    listOperationEvents: jest.fn(),
    cancelOperation: jest.fn(),
    capabilities: {},
    ...overrides,
  }
}

beforeEach(() => {
  opsState = ops()
})

/**
 * Both gates are the desktop route's, kept identical. A locked account and an
 * unconnected controller are the same two facts on a phone, and showing an
 * empty fleet instead would invent a third.
 */
it("keeps the locked-account gate rather than showing an empty fleet", () => {
  opsState = ops({ accountId: null })
  render(<ServersMobileBody />)
  expect(screen.queryByTestId("servers-mobile-body")).not.toBeInTheDocument()
  expect(screen.getByText("servers.connection.unlockAccount")).toBeInTheDocument()
})

it("shows the connect panel when no controller is attached", () => {
  opsState = ops({ connected: false })
  render(<ServersMobileBody />)
  expect(screen.getByTestId("ops-connect-panel")).toBeInTheDocument()
})

/** The fleet is the page here, not a pane collapsed behind a 16px panel icon. */
it("renders the desktop fleet component as the page", () => {
  render(<ServersMobileBody />)
  expect(screen.getByTestId("servers-mobile-body")).toBeInTheDocument()
  expect(screen.getByTestId("server-fleet")).toBeInTheDocument()
})

/** Which controller this is, the first thing to check when a fleet looks wrong. */
it("names the controller under the title", () => {
  render(<ServersMobileBody />)
  expect(screen.getByText("https://ops.example.com")).toBeInTheDocument()
})

it("offers deploy and enrollment, and opens each", async () => {
  render(<ServersMobileBody />)
  await userEvent.click(screen.getByTestId("mobile-servers-deploy"))
  expect(screen.getByTestId("deployment-wizard")).toBeInTheDocument()
})

/**
 * Not disabled on an empty fleet, matching the desktop: the dialog's own "No
 * targets yet" state explains that a token binds to a target, which a dead
 * button does not.
 */
it("offers enrollment even with no targets yet", async () => {
  render(<ServersMobileBody />)
  expect(screen.getByTestId("mobile-servers-enroll")).toBeEnabled()
  await userEvent.click(screen.getByTestId("mobile-servers-enroll"))
  expect(screen.getByTestId("connect-agent-dialog")).toBeInTheDocument()
})

/**
 * The rail is where a running deploy reports itself, so it gets a labelled
 * trigger rather than the shell's unlabelled panel icon.
 */
it("puts the operations rail behind a labelled trigger", async () => {
  render(<ServersMobileBody />)
  await userEvent.click(screen.getByTestId("mobile-servers-operations"))
  expect(await screen.findByTestId("operations-rail")).toBeInTheDocument()
})

it("counts only the operations still in flight on that trigger", () => {
  opsState = ops({
    operations: [
      { id: "o1", targetId: "s1", kind: "deploy", state: "executing" },
      { id: "o2", targetId: "s1", kind: "deploy", state: "succeeded" },
      { id: "o3", targetId: "s2", kind: "deploy", state: "queued" },
    ],
  })
  render(<ServersMobileBody />)
  expect(screen.getByTestId("mobile-servers-operations")).toHaveTextContent("2")
})

it("says when the fleet is a cached copy", () => {
  opsState = ops({ offline: true })
  render(<ServersMobileBody />)
  expect(screen.getByText("servers.offline")).toBeInTheDocument()
})
