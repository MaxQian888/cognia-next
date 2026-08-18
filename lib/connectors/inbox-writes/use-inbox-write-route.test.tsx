/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"

// The hook re-renders on three independent inputs; each is a plain
// subscribe(cb) => unsubscribe seam, so the fakes just capture the listener.
const listeners: { remote: Array<() => void>; snapshot: Array<() => void>; store: Array<() => void> } =
  { remote: [], snapshot: [], store: [] }

jest.mock("@/lib/tauri/transport-routing", () => ({
  isRemoteHostActive: jest.fn(() => false),
  subscribeActiveRemoteTransport: (cb: () => void) => {
    listeners.remote.push(cb)
    return () => {
      listeners.remote = listeners.remote.filter((l) => l !== cb)
    }
  },
}))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: jest.fn(() => ({
    target: null,
    vaultState: "unlocked",
    connectionState: "online",
  })),
  subscribeRuntimeSnapshot: (cb: () => void) => {
    listeners.snapshot.push(cb)
    return () => {
      listeners.snapshot = listeners.snapshot.filter((l) => l !== cb)
    }
  },
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  activeHostFeatureManifest: jest.fn(() => null),
  useRemoteHostStore: {
    subscribe: (cb: () => void) => {
      listeners.store.push(cb)
      return () => {
        listeners.store = listeners.store.filter((l) => l !== cb)
      }
    },
  },
}))

import { INBOX_RELAY_HOST_OPERATIONS } from "@/lib/platform/host-feature-manifest"
import { __setInboxWriteRouteDepsForTests } from "./route"
import { useInboxWriteReadiness, useInboxWriteRoute } from "./use-inbox-write-route"

let route: "local" | "remote" | "unavailable" = "unavailable"
let restore: () => void = () => undefined

function RouteProbe() {
  return <span data-testid="route">{useInboxWriteRoute()}</span>
}

function ReadinessProbe() {
  const readiness = useInboxWriteReadiness()
  return (
    <>
      <span data-testid="route">{readiness.route}</span>
      <span data-testid="host">{String(readiness.hostSupported)}</span>
      <span data-testid="state">{readiness.availability.state}</span>
    </>
  )
}

/** Fire every subscription the hook installed. */
function notifyAll(): void {
  act(() => {
    for (const group of [listeners.remote, listeners.snapshot, listeners.store]) {
      for (const cb of [...group]) cb()
    }
  })
}

beforeEach(() => {
  listeners.remote = []
  listeners.snapshot = []
  listeners.store = []
  route = "unavailable"
  restore = __setInboxWriteRouteDepsForTests({
    isRemoteHostActive: () => route === "remote",
    hasConnectorRuntime: () => route === "local",
    getRuntimeSnapshot: () => ({
      target: null,
      vaultState: "unlocked",
      connectionState: "online",
    }),
    activeHostFeatureManifest: () =>
      route === "remote"
        ? ({
            schemaVersion: 1,
            hostBuildId: "h",
            platform: "tauri",
            features: {
              "connectors.inbox-relay": {
                version: 1,
                operations: [...INBOX_RELAY_HOST_OPERATIONS],
              },
            },
          } as never)
        : null,
  })
})

afterEach(() => restore())

describe("useInboxWriteRoute", () => {
  it("renders the current route", () => {
    route = "local"
    render(<RouteProbe />)
    expect(screen.getByTestId("route")).toHaveTextContent("local")
  })

  it("re-renders when any of the three inputs changes", () => {
    render(<RouteProbe />)
    expect(screen.getByTestId("route")).toHaveTextContent("unavailable")

    route = "local"
    notifyAll()
    expect(screen.getByTestId("route")).toHaveTextContent("local")

    route = "remote"
    notifyAll()
    expect(screen.getByTestId("route")).toHaveTextContent("remote")
  })

  it("subscribes to all three sources and unsubscribes on unmount", () => {
    const { unmount } = render(<RouteProbe />)
    expect(listeners.remote).toHaveLength(1)
    expect(listeners.snapshot).toHaveLength(1)
    expect(listeners.store).toHaveLength(1)

    unmount()
    expect(listeners.remote).toHaveLength(0)
    expect(listeners.snapshot).toHaveLength(0)
    expect(listeners.store).toHaveLength(0)
  })
})

describe("useInboxWriteReadiness", () => {
  it("reports route, host support and per-command availability together", () => {
    route = "local"
    render(<ReadinessProbe />)
    expect(screen.getByTestId("route")).toHaveTextContent("local")
    expect(screen.getByTestId("host")).toHaveTextContent("true")
    expect(screen.getByTestId("state")).toHaveTextContent("available")
  })

  it("reports the standalone case the RequiresHost card renders for", () => {
    render(<ReadinessProbe />)
    expect(screen.getByTestId("route")).toHaveTextContent("unavailable")
    expect(screen.getByTestId("host")).toHaveTextContent("false")
    expect(screen.getByTestId("state")).toHaveTextContent("unsupported")
  })

  it("does not loop: a notification with no change keeps the same snapshot", () => {
    // `useSyncExternalStore` compares snapshots by identity, so the hook
    // serialises. A fresh object each read would re-render forever.
    route = "local"
    render(<ReadinessProbe />)
    notifyAll()
    notifyAll()
    expect(screen.getByTestId("state")).toHaveTextContent("available")
  })
})
