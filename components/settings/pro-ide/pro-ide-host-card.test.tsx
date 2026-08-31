/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ProIdeHostCard } from "./pro-ide-host-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("sonner", () => ({ toast: { error: jest.fn(), info: jest.fn() } }))

let endpointBaseUrl: string | null = "http://127.0.0.1:27891"
jest.mock("@/lib/tauri/companion-endpoint", () => ({
  defaultCompanionEndpointResolver: async () =>
    endpointBaseUrl === null ? null : { baseUrl: endpointBaseUrl },
}))

let hostSupports = true
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  activeHostSupportsFeature: (...args: unknown[]) => {
    lastFeatureQuery = args
    return hostSupports
  },
}))
let lastFeatureQuery: unknown[] = []

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
  hostSupports = true
  reach = { available: true }
  projects = [{ id: "p1", roots: [{ path: "/srv/repo", isPrimary: true }] }]
  activeProjectId = "p1"
  status.mockResolvedValue({ running: false, port: null, version: "1.0.0" })
  ensure.mockResolvedValue({ running: true, port: null, version: "1.0.0" })
  stop.mockResolvedValue(true)
})

afterEach(() => jest.clearAllMocks())

describe("<ProIdeHostCard />", () => {
  it("asks the feature manifest, not the static capability list", async () => {
    // `pro-ide` cannot be in the server-backed capability set: whether a host
    // runs a workbench is a property of that host's build, and the manifest is
    // the only thing that knows.
    render(<ProIdeHostCard />)
    await waitFor(() => expect(status).toHaveBeenCalled())
    expect(lastFeatureQuery).toEqual(["pro-ide", "codeserver_ensure"])
    expect(lastReachInput).toMatchObject({ capability: "pro-ide", hostProvides: true })
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
    hostSupports = false
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
