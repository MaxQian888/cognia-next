/**
 * @jest-environment jsdom
 *
 * The composer's half of an addressed turn (`@claude` / `@codex` /
 * `@<Squad member>` as the LEADING token, `lib/chat/turn-route/`):
 *   - route rows are offered only for the message's first token;
 *   - the leading pill is tinted by the lane it resolves to;
 *   - a send carries `turnMetadata.route` only when the lane can run, and a
 *     refused route keeps the draft with the reason and a way to fix it.
 */

import "fake-indexeddb/auto"

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(),
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
const mockToastError = jest.fn()
jest.mock("sonner", () => {
  const toast = Object.assign(jest.fn(), {
    error: (...args: unknown[]) => mockToastError(...args),
    success: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    message: jest.fn(),
    dismiss: jest.fn(),
    promise: jest.fn(),
    loading: jest.fn(),
    custom: jest.fn(),
  })
  return { toast, Toaster: () => null }
})
// The live targets the `@` panel and the pill paint from. Read lazily so each
// test sets the lanes it means.
const mockRouteState: { targets: unknown[]; options: unknown[] } = { targets: [], options: [] }
jest.mock("@/hooks/chat/use-route-targets", () => ({
  useRouteTargets: ({ enabled }: { enabled: boolean }) =>
    enabled ? mockRouteState : { targets: [], options: [] },
}))
// The send-time re-check: a fresh snapshot, then the lane it resolves to.
const mockSnapshot = jest.fn(async (..._args: unknown[]) => ({ targets: [] }))
const mockRequestRouteStores = jest.fn()
jest.mock("@/lib/chat/turn-route/snapshot", () => ({
  ...jest.requireActual("@/lib/chat/turn-route/snapshot"),
  snapshotRouteContext: (...args: unknown[]) => mockSnapshot(...args),
  requestRouteStores: () => mockRequestRouteStores(),
}))
const mockResolveLane = jest.fn()
jest.mock("@/lib/chat/turn-route/resolve", () => ({
  ...jest.requireActual("@/lib/chat/turn-route/resolve"),
  resolveRouteLane: (...args: unknown[]) => mockResolveLane(...args),
}))
const mockSessionStatus = jest.fn((_sessionId: string) => "idle")
jest.mock("@/hooks/chat/steer-runtime", () => ({
  ...jest.requireActual("@/hooks/chat/steer-runtime"),
  sessionStatusOf: (sessionId: string) => mockSessionStatus(sessionId),
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { ChatSession } from "@cognia/agent-config-types"

const CODEX: MentionTarget = {
  kind: "virtual",
  id: "__virtual_codex__",
  name: "codex",
  handle: "codex",
  runtime: "codex-app-server",
  description: "Codex",
}
const CODEX_ROUTE = {
  target: { kind: "runtime", runtime: "codex" },
  handle: "codex",
  label: "codex",
}
const READY_LANE = { ok: true, runtimeRef: { kind: "external", agentId: "codex-1" } }
const MISSING_LANE = { ok: false, reason: "not-configured", runtime: "codex-app-server" }

function adapter(): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
  }
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <DataAdapterProvider adapter={adapter()}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_route_1",
  title: "Route",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

function renderComposer({
  session = mkSession(),
  onSend = jest.fn(async (..._args: unknown[]) => undefined),
  onOpenSettings = jest.fn(),
  routing,
}: {
  session?: ChatSession | null
  onSend?: jest.Mock
  onOpenSettings?: jest.Mock
  routing?: boolean
} = {}) {
  render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={onOpenSettings}
        onSend={onSend}
        onStop={async () => undefined}
        routing={routing}
      />
    </Wrapper>
  )
  return { ta: document.querySelector("textarea")! as HTMLTextAreaElement, onSend, onOpenSettings }
}

function setLanes(lane: unknown) {
  mockRouteState.targets = [CODEX]
  mockRouteState.options = [{ target: CODEX, lane }]
}

async function type(ta: HTMLTextAreaElement, value: string) {
  await act(async () => {
    fireEvent.change(ta, { target: { value, selectionStart: value.length } })
  })
}

async function send() {
  await act(async () => {
    fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
    await Promise.resolve()
  })
}

beforeEach(async () => {
  useChatStore.getState().clear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  mockToastError.mockReset()
  mockSnapshot.mockClear()
  mockRequestRouteStores.mockClear()
  mockResolveLane.mockReset()
  mockSessionStatus.mockReset()
  mockSessionStatus.mockReturnValue("idle")
  mockRouteState.targets = []
  mockRouteState.options = []
})

describe("Composer — route rows in the @ panel", () => {
  it("offers the runtimes when @ is the message's first token", async () => {
    setLanes(READY_LANE)
    const { ta } = renderComposer()
    await type(ta, "@")
    expect(await screen.findByText("@codex")).toBeInTheDocument()
  })

  it("asks for the Squad stores the first time the route rows open, not before", async () => {
    // The members section reads a mirror the chat route does not boot on its
    // own in the development profile.
    setLanes(READY_LANE)
    const { ta } = renderComposer()
    await type(ta, "hello")
    expect(mockRequestRouteStores).not.toHaveBeenCalled()
    await type(ta, "@")
    await waitFor(() => expect(mockRequestRouteStores).toHaveBeenCalledTimes(1))
  })

  it("does not offer them for an @ further into the message", async () => {
    // Only the leading token routes, so a mid-sentence `@codex` must never be
    // offered as something that would move the turn.
    setLanes(READY_LANE)
    const { ta } = renderComposer()
    await type(ta, "ask @")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.queryByText("@codex")).not.toBeInTheDocument()
    // Same composer, same targets: moved to the front, the `@` offers them —
    // so the absence above is the position, not a panel that never opened.
    await type(ta, "@")
    expect(await screen.findByText("@codex")).toBeInTheDocument()
  })

  it("offers nothing to route from a new-chat composer whose first turn lands in a team room", async () => {
    // No session to read: the shell says where the first turn goes. A room's
    // send carries no runtime route, so offering one would drop it silently.
    setLanes(READY_LANE)
    const { ta, onSend } = renderComposer({ session: null, routing: false })
    await type(ta, "@")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(screen.queryByText("@codex")).not.toBeInTheDocument()
    await type(ta, "@codex fix the build")
    await send()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    const metadata = onSend.mock.calls[0][3] as { route?: unknown } | undefined
    expect(metadata?.route).toBeUndefined()
    expect(mockRequestRouteStores).not.toHaveBeenCalled()
  })

  it("offers nothing to route in a team room", async () => {
    // A team room routes `@Name` through its own router; the composer's
    // targets are switched off there.
    setLanes(READY_LANE)
    const { ta } = renderComposer({ session: mkSession({ kind: "team", teamId: "team_1" }) })
    await type(ta, "@")
    expect(screen.queryByText("@codex")).not.toBeInTheDocument()
  })
})

describe("Composer — the leading route pill", () => {
  const pill = () => document.querySelector("[data-chip='mention']")

  it("tints a leading handle whose runtime can answer", async () => {
    setLanes(READY_LANE)
    const { ta } = renderComposer()
    await type(ta, "@codex fix the build")
    await waitFor(() => expect(pill()).toHaveAttribute("data-route-state", "ready"))
  })

  it("marks a leading handle whose runtime cannot", async () => {
    setLanes(MISSING_LANE)
    const { ta } = renderComposer()
    await type(ta, "@codex fix the build")
    await waitFor(() => expect(pill()).toHaveAttribute("data-route-state", "unavailable"))
  })

  it("leaves a mid-sentence handle an ordinary mention", async () => {
    setLanes(READY_LANE)
    const { ta } = renderComposer()
    await type(ta, "ask @codex later")
    await waitFor(() => expect(pill()).toBeTruthy())
    expect(pill()).not.toHaveAttribute("data-route-state")
  })
})

describe("Composer — sending an addressed turn", () => {
  it("carries the route when its lane can run", async () => {
    setLanes(READY_LANE)
    mockResolveLane.mockReturnValue(READY_LANE)
    const { ta, onSend } = renderComposer()
    await type(ta, "@codex fix the build")
    await send()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    // The transcript keeps what was typed; the controller strips the token
    // from what the runtime sees.
    expect(onSend.mock.calls[0][0]).toBe("@codex fix the build")
    expect(onSend.mock.calls[0][3]).toEqual(expect.objectContaining({ route: CODEX_ROUTE }))
    // Re-checked against a fresh snapshot of THIS conversation at send time.
    expect(mockSnapshot).toHaveBeenCalledWith("ses_route_1", expect.anything())
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it("carries no route for a handle that is not the first token", async () => {
    setLanes(READY_LANE)
    const { ta, onSend } = renderComposer()
    await type(ta, "ask @codex later")
    await send()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    const metadata = onSend.mock.calls[0][3] as { route?: unknown } | undefined
    expect(metadata?.route).toBeUndefined()
    expect(mockSnapshot).not.toHaveBeenCalled()
  })

  it("refuses a route whose lane cannot run, keeps the draft, and offers the fix", async () => {
    setLanes(MISSING_LANE)
    mockResolveLane.mockReturnValue(MISSING_LANE)
    const { ta, onSend, onOpenSettings } = renderComposer()
    await type(ta, "@codex fix the build")
    await send()
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    expect(onSend).not.toHaveBeenCalled()
    expect(ta.value).toBe("@codex fix the build")
    const [title, options] = mockToastError.mock.calls[0] as [
      string,
      { description: string; action: { label: string; onClick: () => void } },
    ]
    expect(title).toContain("@codex")
    expect(options.description).toBeTruthy()
    options.action.onClick()
    expect(onOpenSettings).toHaveBeenCalledWith("agents")
  })

  it("sends a missing Squad member's fix to the Squad settings", async () => {
    const member: MentionTarget = {
      kind: "teammate",
      id: "tm_1",
      name: "Reviewer",
      handle: "reviewer",
      squadId: "sq_1",
      squadName: "Review Squad",
      runtime: "claude",
      teammate: { id: "tm_1", teamId: "sq_1", name: "Reviewer" } as never,
      description: "",
      nameCollision: false,
    }
    const gone = { ok: false, reason: "member-missing" }
    mockRouteState.targets = [member]
    mockRouteState.options = [{ target: member, lane: READY_LANE }]
    mockResolveLane.mockReturnValue(gone)
    const { ta, onSend, onOpenSettings } = renderComposer()
    await type(ta, "@reviewer look at this")
    await send()
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    expect(onSend).not.toHaveBeenCalled()
    const options = mockToastError.mock.calls[0][1] as { action: { onClick: () => void } }
    options.action.onClick()
    expect(onOpenSettings).toHaveBeenCalledWith("squads")
  })

  it("refuses a route while a reply is still running", async () => {
    // A live follow-up can only reach the runtime already answering.
    setLanes(READY_LANE)
    mockResolveLane.mockReturnValue(READY_LANE)
    mockSessionStatus.mockReturnValue("streaming")
    const { ta, onSend } = renderComposer()
    await type(ta, "@codex fix the build")
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" })
      await Promise.resolve()
    })
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    expect(onSend).not.toHaveBeenCalled()
    expect(mockSnapshot).not.toHaveBeenCalled()
    expect(ta.value).toBe("@codex fix the build")
  })

  it("refuses a bare handle with nothing to ask", async () => {
    setLanes(READY_LANE)
    mockResolveLane.mockReturnValue(READY_LANE)
    const { ta, onSend } = renderComposer()
    await type(ta, "@codex")
    await send()
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    expect(onSend).not.toHaveBeenCalled()
    expect(ta.value).toBe("@codex")
  })

  it("routes the first message of a new chat too", async () => {
    setLanes(READY_LANE)
    mockResolveLane.mockReturnValue(READY_LANE)
    const { ta, onSend } = renderComposer({ session: null })
    await type(ta, "@codex start here")
    await send()
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onSend.mock.calls[0][3]).toEqual(expect.objectContaining({ route: CODEX_ROUTE }))
    expect(mockSnapshot).toHaveBeenCalledWith(null, expect.anything())
  })
})
