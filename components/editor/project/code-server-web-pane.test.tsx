/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"

const ensure = jest.fn()
const resolveEndpoint = jest.fn()
const useCodeServerProjectOpener = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))
jest.mock("@/lib/codeserver/client", () => ({
  codeServerClient: { ensure: (...args: unknown[]) => ensure(...args) },
}))
jest.mock("@/lib/tauri/companion-endpoint", () => ({
  defaultCompanionEndpointResolver: () => resolveEndpoint(),
}))
jest.mock("@/hooks/codeserver/use-code-server-project-opener", () => ({
  useCodeServerProjectOpener: (options: unknown) => useCodeServerProjectOpener(options),
}))
jest.mock("./code-server-web-frame", () => ({
  CodeServerWebFrame: ({
    status,
    hostBaseUrl,
    onEmbeddedChange,
  }: {
    status: { running?: boolean; port?: number } | null
    hostBaseUrl: string | null
    onEmbeddedChange?: (embedded: boolean) => void
  }) => {
    mockReportEmbedded = onEmbeddedChange
    return (
      <div
        data-testid="web-frame"
        data-running={String(status?.running ?? false)}
        data-port={status?.port ?? ""}
        data-host={hostBaseUrl ?? "self"}
      />
    )
  },
}))

let mockReportEmbedded: ((embedded: boolean) => void) | undefined

import { CodeServerWebPane } from "./code-server-web-pane"

beforeEach(() => {
  jest.clearAllMocks()
  mockReportEmbedded = undefined
  ensure.mockResolvedValue({ running: true, port: 8321 })
  resolveEndpoint.mockResolvedValue(null)
})

describe("CodeServerWebPane", () => {
  it("starts the host's workbench for this root and hands the frame its status", async () => {
    render(<CodeServerWebPane root="/repo" />)
    expect(screen.getByTestId("code-server-web-loading")).toBeInTheDocument()

    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(ensure).toHaveBeenCalledWith("/repo", "managed")
    const frame = screen.getByTestId("web-frame")
    expect(frame).toHaveAttribute("data-running", "true")
    expect(frame).toHaveAttribute("data-port", "8321")
    expect(frame).toHaveAttribute("data-host", "self")
  })

  it("passes the profile the user picked through to the host", async () => {
    render(<CodeServerWebPane root="/repo" profile="native" />)
    await waitFor(() => expect(ensure).toHaveBeenCalledWith("/repo", "native"))
  })

  it("waits for the host answer before pointing a frame at loopback", async () => {
    let settle: (value: { baseUrl: string } | null) => void = () => {}
    resolveEndpoint.mockReturnValue(
      new Promise<{ baseUrl: string } | null>((resolve) => {
        settle = resolve
      })
    )
    render(<CodeServerWebPane root="/repo" />)

    // The workbench answers first. Rendering here would read the unresolved
    // host as "this shell IS the host" and frame 127.0.0.1 on another machine.
    await waitFor(() => expect(ensure).toHaveBeenCalled())
    expect(screen.queryByTestId("web-frame")).toBeNull()
    expect(screen.getByTestId("code-server-web-loading")).toBeInTheDocument()

    settle({ baseUrl: "https://desk.local:7420" })
    await waitFor(() =>
      expect(screen.getByTestId("web-frame")).toHaveAttribute(
        "data-host",
        "https://desk.local:7420"
      )
    )
  })

  it("reports a host that would not start the workbench, and offers a retry", async () => {
    ensure.mockRejectedValue(new Error("no binary for this platform"))
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("code-server-web-error")).toBeInTheDocument())
    expect(screen.getByText(/no binary for this platform/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument()
  })

  it("claims file jumps only while the workbench is actually on screen", async () => {
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ root: "/repo", enabled: true })
    )
  })

  it("leaves file jumps to the read-only viewer when the host is another machine", async () => {
    resolveEndpoint.mockResolvedValue({ baseUrl: "https://desk.local:7420" })
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
  })

  it("claims file jumps for a paired browser on the host's own machine", async () => {
    // The regression: a non-null LOOPBACK base URL is a paired browser standing
    // on the host — `resolveWebWorkbenchTarget` embeds it and the iframe shows
    // the workbench. Gating the opener on `hostBaseUrl === null` asked a
    // narrower question ("is this shell ITSELF the host"), so the IDE was
    // visible and working while every file jump still fell back to the
    // read-only viewer.
    resolveEndpoint.mockResolvedValue({ baseUrl: "http://127.0.0.1:7420" })
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(screen.getByTestId("web-frame")).toHaveAttribute("data-host", "http://127.0.0.1:7420")
    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ root: "/repo", enabled: true })
    )
  })

  it("claims them for an IPv6 loopback pairing too, brackets and all", async () => {
    resolveEndpoint.mockResolvedValue({ baseUrl: "http://[::1]:7420" })
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true })
    )
  })

  it("does not claim them when the host withheld the port", async () => {
    // Same machine, running, but no port: the browser did not arrive on the
    // loopback plaintext listener, so there is no second way in and the frame
    // renders a notice rather than a workbench.
    ensure.mockResolvedValue({ running: true })
    resolveEndpoint.mockResolvedValue({ baseUrl: "http://127.0.0.1:7420" })
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
  })

  it("does not claim them for a workbench that is not running", async () => {
    ensure.mockResolvedValue({ running: false })
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
  })

  it("withdraws the claim when code-server refuses to be framed", async () => {
    // Framing is the one half the target cannot answer in advance. Once the
    // frame falls back to an "open in a tab" link the workbench is no longer on
    // screen, and routing jumps into it would send them nowhere visible.
    render(<CodeServerWebPane root="/repo" />)
    await waitFor(() => expect(screen.getByTestId("web-frame")).toBeInTheDocument())
    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true })
    )

    act(() => mockReportEmbedded?.(false))

    expect(useCodeServerProjectOpener).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
  })
})
