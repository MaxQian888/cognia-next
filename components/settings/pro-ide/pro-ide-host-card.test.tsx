/**
 * @jest-environment jsdom
 */

import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ProIdeHostCard } from "./pro-ide-host-card"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), info: jest.fn() } }))

let endpointBaseUrl: string | null = "http://127.0.0.1:27891"
const mockResolveEndpoint = jest.fn(async () =>
  endpointBaseUrl === null ? null : { baseUrl: endpointBaseUrl }
)
jest.mock("@/lib/tauri/companion-endpoint", () => ({
  defaultCompanionEndpointResolver: () => mockResolveEndpoint(),
}))

// The frame's own embed-or-explain logic has its own suite; here it only has to
// show which Host it was handed.
jest.mock("@/components/editor/project/code-server-web-frame", () => ({
  CodeServerWebFrame: ({ hostBaseUrl }: { hostBaseUrl: string | null }) => (
    <div data-testid="frame-host">{hostBaseUrl ?? "self"}</div>
  ),
}))

/**
 * The real remote-host store, seeded the way an activation leaves it: the
 * card subscribes to it, so a test can switch hosts under a mounted card and
 * watch it follow. `operations` is what the host's build advertises for
 * `pro-ide`; `null` means the feature is absent altogether.
 */
function hostState(id: string, operations: string[] | null = ["codeserver_ensure"]) {
  return {
    activeHostId: id,
    hosts: [
      {
        id,
        label: id,
        config: { baseUrl: `https://${id}.example`, serverVersion: "1.0.0" } as CompanionConfig,
        credentialRef: `remote-host:${id}`,
        addedAt: 1,
        connectionState: "ready" as const,
        featureManifest: {
          schemaVersion: 1,
          hostBuildId: "1.0.0",
          platform: "headless",
          generatedAt: 1,
          features: operations ? { "pro-ide": { version: 1, operations } } : {},
          limits: {},
        } as unknown as HostFeatureManifest,
      },
    ],
  }
}

let projects: Array<{ id: string; roots: Array<{ path: string; isPrimary?: boolean }> }> = []
let activeProjectId: string | null = null
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (s: unknown) => unknown) => selector({ projects, activeProjectId }),
}))

const status = jest.fn()
const ensure = jest.fn()
const stop = jest.fn()
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: {
    status: (...a: unknown[]) => status(...a),
    ensure: (...a: unknown[]) => ensure(...a),
    stop: (...a: unknown[]) => stop(...a),
  },
}))

let reach: { available: boolean; block?: string } = { available: true }
let lastReachInput: unknown = null
jest.mock("@/hooks/platform/use-surface-reach", () => ({
  useSurfaceReach: (input: unknown) => {
    lastReachInput = input
    return reach
  },
}))

jest.mock("@/components/platform/surface-unavailable-notice", () => ({
  SurfaceUnavailableNotice: (props: Record<string, unknown>) => (
    <div data-testid={props["data-testid"] as string} />
  ),
}))

beforeEach(() => {
  endpointBaseUrl = "http://127.0.0.1:27891"
  useRemoteHostStore.setState(hostState("h1"))
  reach = { available: true }
  projects = [{ id: "p1", roots: [{ path: "/srv/repo", isPrimary: true }] }]
  activeProjectId = "p1"
  status.mockResolvedValue({ running: false, port: null, version: "1.0.0" })
  ensure.mockResolvedValue({ running: true, port: null, version: "1.0.0" })
  stop.mockResolvedValue(true)
})

afterEach(() => {
  jest.clearAllMocks()
  useRemoteHostStore.setState({ activeHostId: null, hosts: [] })
})

describe("<ProIdeHostCard />", () => {
  it("asks the feature manifest, not the static capability list", async () => {
    // `pro-ide` cannot be in the server-backed capability set: whether a host
    // runs a workbench is a property of that host's build, and the manifest is
    // the only thing that knows.
    render(<ProIdeHostCard />)
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(lastReachInput).toMatchObject({ capability: "pro-ide", hostProvides: true })
  })

  it("needs the host to advertise `codeserver_ensure`, not just the feature", async () => {
    useRemoteHostStore.setState(hostState("h1", ["codeserver_status"]))
    render(<ProIdeHostCard />)
    expect(lastReachInput).toMatchObject({ capability: "pro-ide", hostProvides: false })
    // Let the endpoint resolution settle inside the test.
    await act(async () => {})
  })

  it("follows a desktop's host switch: re-answers, re-resolves and re-probes", async () => {
    status.mockResolvedValue({ running: true, port: 41234, version: "1.0.0" })
    endpointBaseUrl = "https://h1.example"
    const { rerender } = render(<ProIdeHostCard />)
    await waitFor(() => expect(screen.getByTestId("frame-host")).toHaveTextContent("h1.example"))
    expect(mockResolveEndpoint).toHaveBeenCalledTimes(1)

    // Ordinary re-renders and unrelated store writes must not re-resolve: the
    // frame would otherwise risk flipping while the user types in it.
    rerender(<ProIdeHostCard />)
    act(() =>
      useRemoteHostStore.setState((state) => ({
        hosts: state.hosts.map((host) => ({ ...host, label: "renamed" })),
      }))
    )
    expect(mockResolveEndpoint).toHaveBeenCalledTimes(1)

    // The desktop attaches to another host that also runs a workbench. No prop
    // changes; only the store moves.
    status.mockClear()
    endpointBaseUrl = "https://h2.example"
    act(() => useRemoteHostStore.setState(hostState("h2")))
    await waitFor(() => expect(screen.getByTestId("frame-host")).toHaveTextContent("h2.example"))
    expect(mockResolveEndpoint).toHaveBeenCalledTimes(2)
    // Same root, same reach: only the host key can have re-run the probe.
    await waitFor(() => expect(status).toHaveBeenCalledWith("/srv/repo"))

    // A host whose build has no workbench flips the answer without a remount.
    act(() => useRemoteHostStore.setState(hostState("h3", null)))
    expect(lastReachInput).toMatchObject({ capability: "pro-ide", hostProvides: false })
    await act(async () => {})
  })

  it("reads the host's status for the active project root", async () => {
    render(<ProIdeHostCard />)
    await waitFor(() => expect(status).toHaveBeenCalledWith("/srv/repo"))
    expect(screen.getByTestId("pro-ide-host-root")).toHaveTextContent("/srv/repo")
  })

  it("starts the host workbench and reflects that it is running", async () => {
    render(<ProIdeHostCard />)
    await waitFor(() => expect(status).toHaveBeenCalled())
    await userEvent.click(screen.getByTestId("pro-ide-host-toggle"))
    expect(ensure).toHaveBeenCalledWith("/srv/repo")
    await waitFor(() => expect(screen.getByTestId("pro-ide-host-running")).toBeInTheDocument())
  })

  it("stops it once it is running", async () => {
    status.mockResolvedValue({ running: true, port: null, version: "1.0.0" })
    render(<ProIdeHostCard />)
    await waitFor(() => expect(screen.getByTestId("pro-ide-host-running")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("pro-ide-host-toggle"))
    expect(stop).toHaveBeenCalledWith("/srv/repo")
  })

  it("says where the workbench can be opened while nothing is running", async () => {
    // "Start it" alone reads as "and then open it here", which is only true on
    // the host's own machine. The sentence carries the rest.
    render(<ProIdeHostCard />)
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(screen.getByTestId("pro-ide-host-where")).toHaveTextContent("openWhere")
    expect(screen.queryByTestId("pro-ide-host-frame")).not.toBeInTheDocument()
  })

  it("hands a running workbench to the frame, which decides embed or explain", async () => {
    status.mockResolvedValue({ running: true, port: 41234, version: "1.0.0" })
    render(<ProIdeHostCard />)
    await waitFor(() => expect(screen.getByTestId("pro-ide-host-frame")).toBeInTheDocument())
    // The sentence is gone: the frame says the same thing more precisely, and
    // on a host-local browser it says nothing because the workbench is there.
    expect(screen.queryByTestId("pro-ide-host-where")).not.toBeInTheDocument()
  })

  it("explains rather than disappearing when the host does not run a workbench", async () => {
    useRemoteHostStore.setState(hostState("h1", null))
    reach = { available: false, block: "host-lacks-capability" }
    render(<ProIdeHostCard />)
    expect(screen.getByTestId("pro-ide-host-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("pro-ide-host-toggle")).not.toBeInTheDocument()
    // No probe against a host that cannot answer it.
    expect(status).not.toHaveBeenCalled()
  })

  it("refuses to start without a workspace instead of guessing a root", async () => {
    activeProjectId = null
    render(<ProIdeHostCard />)
    expect(screen.getByTestId("pro-ide-host-root")).toHaveTextContent("noWorkspace")
    expect(screen.getByTestId("pro-ide-host-toggle")).toBeDisabled()
    expect(status).not.toHaveBeenCalled()
  })

  it("treats a host that cannot answer as not running rather than as an error", async () => {
    status.mockRejectedValue(new Error("unreachable"))
    render(<ProIdeHostCard />)
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(screen.queryByTestId("pro-ide-host-running")).not.toBeInTheDocument()
  })
})
