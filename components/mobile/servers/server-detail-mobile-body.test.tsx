/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

jest.mock("@/components/servers/connect-agent-dialog", () => ({
  ConnectAgentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="connect-agent-dialog" /> : null,
}))
jest.mock("@/components/servers/operation-inspector", () => ({
  OperationInspector: () => null,
}))
jest.mock("@/components/servers/operations-rail", () => ({
  OperationsRail: ({ targetId }: { targetId?: string }) => (
    <div data-testid="operations-rail" data-target={targetId ?? ""} />
  ),
}))
jest.mock("@/components/servers/server-visuals", () => ({
  HealthLabel: ({ health }: { health: string }) => <span>{`health:${health}`}</span>,
}))

// eslint-disable-next-line no-var -- jest.mock factories hoist above this body.
var detailProps: Record<string, unknown> | null
jest.mock("@/components/servers/server-detail", () => ({
  ServerDetailView: (props: Record<string, unknown>) => {
    detailProps = props
    return <div data-testid="server-detail-view" />
  },
}))

// eslint-disable-next-line no-var -- same hoisting rule.
var opsState: Record<string, unknown>
jest.mock("@/components/servers/ops-context", () => ({
  useServerOps: () => opsState,
}))

import { ServerDetailMobileBody } from "./server-detail-mobile-body"

const SERVER = {
  id: "srv-1",
  label: "prod-eu",
  health: "healthy",
  publicUrl: "https://prod-eu.example.com",
} as never

const ACTIONS = {
  onBackup: jest.fn(),
  onPreflight: jest.fn(),
  onCollectStatus: jest.fn(),
  onCollectLogs: jest.fn(),
  onRestore: jest.fn(),
  onRollback: jest.fn(),
  onRotateKey: jest.fn(),
  onUpgrade: jest.fn(),
}

beforeEach(() => {
  detailProps = null
  opsState = {
    connection: { controllerUrl: "https://ops.example.com" },
    servers: [],
    operations: [],
    liveEvents: true,
    eventStreamConnected: true,
    loading: false,
    refresh: jest.fn(),
    createEnrollmentToken: jest.fn(),
    listOperationEvents: jest.fn(),
    cancelOperation: jest.fn(),
  }
})

function renderBody() {
  return render(
    <ServerDetailMobileBody
      server={SERVER}
      backups={[]}
      logs={[]}
      loadingDetail={false}
      actions={ACTIONS}
    />
  )
}

/**
 * Every action reaches the phone. A surface that could read a target but not
 * roll it back would be this route telling the user to go and find a laptop.
 */
it("hands the whole action set to the shared detail view", () => {
  renderBody()
  expect(screen.getByTestId("server-detail-view")).toBeInTheDocument()
  expect(Object.keys(detailProps?.actions as object).sort()).toEqual([
    "onBackup",
    "onCollectLogs",
    "onCollectStatus",
    "onConnectAgent",
    "onPreflight",
    "onRestore",
    "onRollback",
    "onRotateKey",
    "onUpgrade",
  ])
})

it("keeps a way back to the fleet", () => {
  renderBody()
  expect(screen.getByTestId("mobile-server-detail-back")).toHaveAttribute("href", "/servers")
})

it("states the target's identity and health above the tabs", () => {
  renderBody()
  expect(screen.getByText("prod-eu")).toBeInTheDocument()
  expect(screen.getByText("health:healthy")).toBeInTheDocument()
  expect(screen.getByText("srv-1")).toBeInTheDocument()
})

/**
 * The rail is scoped on this route, so a busy fleet does not bury the one
 * deploy the reader came here for.
 */
it("scopes the operations rail to this target", async () => {
  const { getByTestId, findByTestId } = renderBody()
  getByTestId("mobile-servers-operations").click()
  expect(await findByTestId("operations-rail")).toHaveAttribute("data-target", "srv-1")
})
