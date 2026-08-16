/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

jest.mock("@/components/chat/motion/motion-reveal", () => ({
  MotionPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
}))

const sessions: Record<string, { kind?: string }> = {}
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: (selector: (state: unknown) => unknown) => selector({ sessions }),
}))

import { TerminalForwardPanel } from "./terminal-forward-panel"
import type { SshForwardStatus } from "@/lib/terminal/ssh-forward-control"

function row(overrides: Partial<SshForwardStatus> = {}): SshForwardStatus {
  return {
    id: "lfwd-1",
    direction: "local",
    summary: "127.0.0.1:8080 → db.internal:5432",
    enabled: true,
    state: "listening",
    activeConnections: 0,
    queuedConnections: 0,
    error: null,
    ...overrides,
  }
}

function setSession(kind?: string): void {
  for (const key of Object.keys(sessions)) delete sessions[key]
  sessions["s-1"] = { kind }
}

function renderPanel(
  read: jest.Mock,
  setEnabled: jest.Mock = jest.fn(async () => [])
): ReturnType<typeof render> {
  return render(
    <TerminalForwardPanel sessionId="s-1" read={read as never} setEnabled={setEnabled as never} />
  )
}

describe("TerminalForwardPanel", () => {
  it("renders nothing at all for a local shell and never asks the host", async () => {
    setSession("localPty")
    const read = jest.fn(async () => [row()])
    const { container } = renderPanel(read)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    // A local PTY has no tunnels; polling it would be pure noise on the wire.
    expect(read).not.toHaveBeenCalled()
  })

  it("stays hidden for an SSH tab that has no rules", async () => {
    setSession("ssh")
    const read = jest.fn(async () => [])
    const { container } = renderPanel(read)
    await waitFor(() => expect(read).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("offers a collapsed entry point once the session has rules", async () => {
    setSession("ssh")
    renderPanel(jest.fn(async () => [row()]))
    expect(await screen.findByTestId("terminal-forward-open")).toBeInTheDocument()
    expect(screen.queryByTestId("terminal-forward-panel")).toBeNull()
  })

  it("shows each rule's endpoints, direction, and live counts once opened", async () => {
    setSession("ssh")
    const user = userEvent.setup()
    renderPanel(
      jest.fn(async () => [
        row({ activeConnections: 2, queuedConnections: 1 }),
        row({
          id: "rfwd-1",
          direction: "remote",
          summary: "remote 127.0.0.1:9000 → localhost:3000",
        }),
      ])
    )
    await user.click(await screen.findByTestId("terminal-forward-open"))

    expect(screen.getByTestId("terminal-forward-panel")).toBeInTheDocument()
    expect(screen.getByText("127.0.0.1:8080 → db.internal:5432")).toBeInTheDocument()
    const local = screen.getByTestId("terminal-forward-lfwd-1")
    expect(local.textContent).toContain("direction.local")
    expect(local.textContent).toContain("state.listening")
    expect(local.textContent).toContain('active:{"count":2}')
    expect(local.textContent).toContain('queued:{"count":1}')
    expect(screen.getByTestId("terminal-forward-rfwd-1").textContent).toContain("direction.remote")
  })

  it("omits the connection counts when there are none, rather than showing zeroes", async () => {
    setSession("ssh")
    const user = userEvent.setup()
    renderPanel(jest.fn(async () => [row()]))
    await user.click(await screen.findByTestId("terminal-forward-open"))
    const rule = screen.getByTestId("terminal-forward-lfwd-1")
    expect(rule.textContent).not.toContain("active:")
    expect(rule.textContent).not.toContain("queued:")
  })

  it("surfaces the reason a rule failed alongside its state", async () => {
    setSession("ssh")
    const user = userEvent.setup()
    renderPanel(
      jest.fn(async () => [
        row({
          state: "failed",
          error: "127.0.0.1:8080 could not be bound: address already in use",
        }),
      ])
    )
    await user.click(await screen.findByTestId("terminal-forward-open"))
    expect(screen.getByTestId("terminal-forward-lfwd-1").getAttribute("data-state")).toBe("failed")
    expect(screen.getByTestId("terminal-forward-reason-lfwd-1").textContent).toContain(
      "address already in use"
    )
  })

  it("renders the reply to a toggle rather than assuming the request took", async () => {
    setSession("ssh")
    const user = userEvent.setup()
    const read = jest.fn(async () => [row({ enabled: false, state: "stopped" })])
    // Enabling is a request: the bind can still fail, and when it does the
    // switch must not sit there claiming the rule is on.
    const setEnabled = jest.fn(async () => [
      row({ enabled: true, state: "failed", error: "address already in use" }),
    ])
    renderPanel(read, setEnabled)
    await user.click(await screen.findByTestId("terminal-forward-open"))

    await user.click(screen.getByTestId("terminal-forward-toggle-lfwd-1"))
    expect(setEnabled).toHaveBeenCalledWith("s-1", "lfwd-1", true)
    await waitFor(() =>
      expect(screen.getByTestId("terminal-forward-lfwd-1").getAttribute("data-state")).toBe(
        "failed"
      )
    )
    expect(screen.getByTestId("terminal-forward-reason-lfwd-1")).toBeInTheDocument()
  })

  it("keeps the rules on screen and names the problem when a read fails", async () => {
    setSession("ssh")
    const read = jest
      .fn<Promise<SshForwardStatus[]>, unknown[]>()
      .mockResolvedValueOnce([row()])
      .mockRejectedValue(new Error("terminal host is offline"))
    const user = userEvent.setup()
    renderPanel(read as never)
    await user.click(await screen.findByTestId("terminal-forward-open"))
    // Opening triggers a second read, which fails.
    await waitFor(() =>
      expect(screen.getByTestId("terminal-forward-error").textContent).toBe(
        "terminal host is offline"
      )
    )
    expect(screen.getByTestId("terminal-forward-lfwd-1")).toBeInTheDocument()
  })

  it("reports a rejected toggle without wedging the switch", async () => {
    setSession("ssh")
    const user = userEvent.setup()
    const setEnabled = jest.fn(async () => {
      throw new Error("unknown SSH forward lfwd-1")
    })
    renderPanel(
      jest.fn(async () => [row()]),
      setEnabled as never
    )
    await user.click(await screen.findByTestId("terminal-forward-open"))
    await user.click(screen.getByTestId("terminal-forward-toggle-lfwd-1"))

    await waitFor(() =>
      expect(screen.getByTestId("terminal-forward-error").textContent).toContain("lfwd-1")
    )
    expect(screen.getByTestId("terminal-forward-toggle-lfwd-1")).not.toBeDisabled()
  })

  it("stops polling once the rail is closed again", async () => {
    jest.useFakeTimers({ advanceTimers: true })
    try {
      setSession("ssh")
      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime })
      const read = jest.fn(async () => [row()])
      renderPanel(read)
      await user.click(await screen.findByTestId("terminal-forward-open"))
      const openedAt = read.mock.calls.length

      jest.advanceTimersByTime(6_000)
      await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(openedAt))
      const polled = read.mock.calls.length

      await user.click(screen.getByTestId("terminal-forward-close"))
      // A closed rail runs one last read (so the entry point can hide itself
      // for a session with no rules) and then nothing on a timer.
      const afterClose = read.mock.calls.length
      jest.advanceTimersByTime(10_000)
      expect(read.mock.calls.length).toBe(afterClose)
      expect(afterClose).toBeGreaterThanOrEqual(polled)
    } finally {
      jest.useRealTimers()
    }
  })
})
