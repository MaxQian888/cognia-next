/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
  useFormatter: () => ({ dateTime: () => "TIME" }),
}))
jest.mock("motion/react", () => ({ useReducedMotion: () => true }))
jest.mock("@/hooks/fleet/use-now-ticker", () => ({ useNowTicker: () => 10_000 }))

import { IslandTaskRow } from "./island-task-row"
import { IDLE_ACTION_STATUS } from "@/hooks/island/use-island-actions"
import { NO_ISLAND_CAPABILITIES, type IslandRowProjection } from "@/lib/island/types"

function row(over: Partial<IslandRowProjection> = {}): IslandRowProjection {
  return {
    id: "external:opencode:oc",
    source: "external",
    owner: { kind: "external", agent: "opencode", sessionId: "oc", transcriptPath: "/t" },
    agent: "opencode",
    status: "working",
    priority: 2,
    title: "proj",
    summary: "Bash",
    startedAt: 0,
    updatedAt: 5_000,
    capabilities: { ...NO_ISLAND_CAPABILITIES },
    stale: false,
    ...over,
  }
}

function renderRow(
  over: Partial<IslandRowProjection> = {},
  props: Partial<React.ComponentProps<typeof IslandTaskRow>> = {}
) {
  const dispatch = jest.fn(async () => true)
  render(
    <IslandTaskRow
      row={row(over)}
      revision={9}
      pinned={false}
      onTogglePin={() => {}}
      detail={null}
      detailError={null}
      dispatch={dispatch}
      statusOf={() => IDLE_ACTION_STATUS}
      {...props}
    />
  )
  return dispatch
}

describe("capability gating", () => {
  it("renders no action affordance the projection did not prove", () => {
    renderRow()
    for (const id of [
      "island-open-owner",
      "island-focus-terminal",
      "island-reveal-transcript",
      "island-interrupt",
      "island-dismiss",
      "island-detail-toggle",
      "island-reply-open",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
  })

  it("renders exactly the affordances it did prove", () => {
    renderRow({
      capabilities: {
        ...NO_ISLAND_CAPABILITIES,
        openOwner: true,
        interrupt: true,
        detail: true,
      },
    })
    expect(screen.getByTestId("island-open-owner")).toBeInTheDocument()
    expect(screen.getByTestId("island-interrupt")).toBeInTheDocument()
    expect(screen.getByTestId("island-detail-toggle")).toBeInTheDocument()
    expect(screen.queryByTestId("island-focus-terminal")).toBeNull()
  })

  it("shows the parked permission without controls when it cannot be decided here", () => {
    renderRow({
      status: "blocked",
      statusKey: "awaitingPermission",
      summary: "",
      permission: {
        requestId: "p1",
        kind: "tool",
        toolName: "Bash",
        requestedAt: 0,
        deadline: null,
        allowAlways: false,
      },
    })
    expect(screen.queryByTestId("island-permission-actions")).toBeNull()
    expect(screen.getByTestId("island-status-line").textContent).toContain(
      "state.awaitingPermission"
    )
  })

  it("tells the user a blocked Cognia row without an inline decision is decided in the main window", () => {
    // A Squad review needing a typed answer, a human handoff or an ask-user
    // question has no island control (see IslandRowCapabilities).
    renderRow({
      id: "chat:s1",
      source: "chat",
      owner: { kind: "chat", sessionId: "s1" },
      agent: "cognia",
      status: "blocked",
      statusKey: "awaitingApproval",
      summary: "",
      capabilities: { ...NO_ISLAND_CAPABILITIES, openOwner: true },
    })
    expect(screen.getByTestId("island-decide-in-main").textContent).toContain("decideInMain")
    expect(screen.queryByTestId("island-permission-actions")).toBeNull()
  })

  it("shows the main-window hint on any blocked row without inline controls", () => {
    // An external ask the island has no control for (e.g. an ACP elicitation
    // whose schema doesn't map to options) must still tell the user where the
    // decision lives — a silent blocked row is a dead end.
    renderRow({ status: "blocked", statusKey: "awaitingInput", summary: "" })
    expect(screen.getByTestId("island-decide-in-main").textContent).toContain("decideInMain")
  })

  it("hides the hint once the row exposes its own decision controls", () => {
    renderRow({
      status: "blocked",
      statusKey: "awaitingPermission",
      summary: "",
      permission: {
        requestId: "p1",
        kind: "tool",
        toolName: "Bash",
        requestedAt: 0,
        deadline: null,
        allowAlways: false,
      },
      capabilities: { ...NO_ISLAND_CAPABILITIES, permissionDecision: true },
    })
    expect(screen.queryByTestId("island-decide-in-main")).toBeNull()
  })
})

describe("intent dispatch", () => {
  it("addresses the row it sits on and the revision it was rendered with", () => {
    const dispatch = renderRow({
      capabilities: { ...NO_ISLAND_CAPABILITIES, interrupt: true },
    })
    fireEvent.click(screen.getByTestId("island-interrupt"))
    expect(dispatch).toHaveBeenCalledWith({
      kind: "interrupt",
      rowId: "external:opencode:oc",
      revision: 9,
    })
  })

  it("routes a permission decision through an intent, never a direct command", async () => {
    const dispatch = renderRow({
      status: "blocked",
      permission: {
        requestId: "p1",
        kind: "tool",
        toolName: "Bash",
        requestedAt: 9_995,
        deadline: { at: 29_995, fallback: "terminal" },
        allowAlways: false,
      },
      capabilities: { ...NO_ISLAND_CAPABILITIES, permissionDecision: true },
    })
    fireEvent.click(screen.getByTestId("permission-allow"))
    expect(dispatch).toHaveBeenCalledWith({
      kind: "permission-decision",
      permissionRequestId: "p1",
      behavior: "allow",
      rowId: "external:opencode:oc",
      revision: 9,
    })
    expect(await screen.findByTestId("permission-answered")).toBeInTheDocument()
  })

  it("disables a control while its action is outstanding", () => {
    renderRow(
      { capabilities: { ...NO_ISLAND_CAPABILITIES, interrupt: true } },
      { statusOf: () => ({ pending: true, error: null }) }
    )
    expect(screen.getByTestId("island-interrupt")).toBeDisabled()
  })

  it("offers a conversation's approval with always-allow, and its Stop and reply", async () => {
    const dispatch = renderRow({
      id: "chat:c1",
      source: "chat",
      owner: { kind: "chat", sessionId: "c1", requestId: "r1" },
      agent: undefined,
      status: "blocked",
      permission: {
        requestId: "r1",
        kind: "tool",
        toolName: "Bash",
        requestedAt: 0,
        deadline: null,
        allowAlways: true,
      },
      capabilities: {
        ...NO_ISLAND_CAPABILITIES,
        permissionDecision: true,
        interrupt: true,
        reply: true,
      },
    })
    // No countdown: a conversation's ask waits for the person.
    expect(screen.queryByTestId("permission-countdown")).toBeNull()
    expect(screen.getByTestId("island-interrupt")).toHaveAttribute("aria-label", "stopTurn")
    fireEvent.click(screen.getByTestId("permission-allow-always"))
    expect(dispatch).toHaveBeenCalledWith({
      kind: "permission-decision",
      permissionRequestId: "r1",
      behavior: "allow_always",
      rowId: "chat:c1",
      revision: 9,
    })
    fireEvent.click(screen.getByTestId("island-reply-open"))
    fireEvent.change(screen.getByTestId("island-reply-input"), { target: { value: "go on" } })
    fireEvent.click(screen.getByTestId("island-reply-send"))
    expect(dispatch).toHaveBeenCalledWith({
      kind: "reply",
      text: "go on",
      rowId: "chat:c1",
      revision: 9,
    })
    expect(await screen.findByTestId("permission-answered")).toBeInTheDocument()
  })

  it("words a gate decision as approve or reject", () => {
    renderRow({
      id: "gate:agent-plan:s",
      source: "gate",
      owner: { kind: "gate", gateKey: { scope: "agent-plan", id: "s" } },
      agent: undefined,
      status: "blocked",
      permission: {
        requestId: "s",
        kind: "plan",
        toolName: null,
        requestedAt: 0,
        deadline: null,
        allowAlways: false,
      },
      capabilities: { ...NO_ISLAND_CAPABILITIES, permissionDecision: true },
    })
    expect(screen.getByTestId("island-permission-actions")).toHaveAttribute("data-kind", "plan")
    expect(screen.getByTestId("permission-allow")).toHaveTextContent("approve")
  })

  it("reports why a decision was refused", () => {
    renderRow(
      { capabilities: { ...NO_ISLAND_CAPABILITIES, interrupt: true } },
      {
        statusOf: (kind) =>
          kind === "permission-decision"
            ? { pending: false, error: "noLongerWaiting" }
            : IDLE_ACTION_STATUS,
      }
    )
    expect(screen.getByTestId("island-action-error").textContent).toContain(
      "actionError.noLongerWaiting"
    )
  })

  it("surfaces a retryable error and keeps the row in place", () => {
    renderRow(
      { capabilities: { ...NO_ISLAND_CAPABILITIES, interrupt: true } },
      { statusOf: () => ({ pending: false, error: "timeout" }) }
    )
    expect(screen.getByTestId("island-action-error").textContent).toContain("actionError.timeout")
    expect(screen.getByTestId("island-interrupt")).not.toBeDisabled()
  })
})

describe("privacy", () => {
  it("shows only the safe summary until a detail arrives", () => {
    renderRow({ capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } }, { pinned: true })
    expect(screen.getByTestId("island-detail-status").textContent).toBe("detail.loading")
    expect(screen.queryByTestId("island-prompt")).toBeNull()
    expect(screen.queryByTestId("session-detail")).toBeNull()
  })

  it("shows what a pending decision would allow once revealed", () => {
    renderRow(
      { status: "blocked" },
      {
        pinned: true,
        detail: {
          cwd: null,
          toolUseCount: 0,
          turnCount: 0,
          agentPid: null,
          startedAt: 0,
          status: "waiting-permission",
          model: null,
          permissionMode: null,
          decisionDetail: "git push --force",
        },
      }
    )
    expect(screen.getByTestId("island-decision-detail").textContent).toContain("git push --force")
  })

  it("renders the redacted detail once the main window answers", () => {
    renderRow(
      { capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } },
      {
        pinned: true,
        detail: {
          cwd: "/w",
          toolUseCount: 1,
          turnCount: 1,
          agentPid: null,
          startedAt: 0,
          status: "working",
          model: "claude-opus-5",
          permissionMode: null,
          prompt: "do the thing",
        },
      }
    )
    expect(screen.getByTestId("session-detail")).toBeInTheDocument()
    expect(screen.getByTestId("island-prompt").textContent).toBe("do the thing")
  })

  it("explains a refusal rather than showing an empty panel", () => {
    renderRow(
      { capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } },
      { pinned: true, detailError: "notPermitted" }
    )
    expect(screen.getByTestId("island-detail-status").textContent).toBe("detailError.notPermitted")
  })
})

describe("accessibility", () => {
  it("labels the pin control by its effect and reports its state", () => {
    renderRow({ capabilities: { ...NO_ISLAND_CAPABILITIES, detail: true } })
    const toggle = screen.getByTestId("island-detail-toggle")
    expect(toggle).toHaveAttribute("aria-label", "detail.show")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
  })

  it("names the open-owner control after the plane it opens", () => {
    renderRow({
      source: "team",
      owner: { kind: "team", teamId: "t1" },
      agent: undefined,
      capabilities: { ...NO_ISLAND_CAPABILITIES, openOwner: true },
    })
    expect(screen.getByTestId("island-open-owner")).toHaveAttribute("aria-label", "openOwner.team")
    expect(screen.getByTestId("island-source-badge").textContent).toBe("source.team")
  })

  it("announces how long a blocked row has kept the user waiting", () => {
    renderRow({
      status: "blocked",
      statusKey: "awaitingApproval",
      summary: "",
      waitingSince: 4_000,
    })
    expect(screen.getByTestId("island-waited").textContent).toContain("waitingFor")
  })

  it("passes the configured label through to the agent badge", () => {
    renderRow({ agent: "acp", agentLabel: "My Kiro" })
    expect(screen.getByTestId("agent-badge-acp").textContent).toContain("My Kiro")
  })
})
