/** @jest-environment node */

jest.mock("@tauri-apps/api/core", () => ({
  ...jest.requireActual("@tauri-apps/api/core"),
  invoke: jest.fn(),
}))
jest.mock("@tauri-apps/api/event", () => ({
  ...jest.requireActual("@tauri-apps/api/event"),
  listen: jest.fn(),
}))
jest.mock("@/lib/utils", () => ({
  ...jest.requireActual("@/lib/utils"),
  isTauri: jest.fn(() => true),
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  ...jest.requireActual("@/lib/ai/agent/external/presets"),
  resolvePreferredCodexExecutablePresetId: jest.fn(async () => "codex"),
}))

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import { DEFAULT_PERMISSION_CHOICES } from "../tui/components/overlays/PermissionOverlay"
import { createGateController, runTurn } from "../tui/hooks/turn-engine"
import { createInitialState } from "../tui/state/initial"
import { tuiReducer } from "../tui/state/reducer"
import type { AgentSession } from "../agent/session-runner"
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import { markCliHostProcess } from "../runtime/cli-host-marker"
import { parseArgv } from "./args"
import { chatCommand } from "./chat"

const mockInvoke = invoke as jest.Mock
const mockListen = listen as jest.Mock

describe("external chat integration", () => {
  // `chatCommand` runs under `cli/src/cli/entry.ts` in production, which marks
  // the process as the standalone CLI host before anything in `@/lib` loads.
  // Without that mark a Node process looks like a browser to `detectPlatform`,
  // so the external-agent process plane refuses to start a stdio agent and the
  // turn never reaches the backend at all. Going through the real bootstrap
  // seam keeps this a test of the product's own host detection.
  beforeAll(() => {
    markCliHostProcess()
  })

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).__COGNIA_CLI__
  })

  it("runs chat --backend codex through ACP permission approval into TUI cells", async () => {
    let stdout: ((event: { payload: { agentId: string; data: string } }) => void) | undefined
    let promptRequestId: number | undefined
    let permissionResponse: Record<string, unknown> | undefined

    mockListen.mockImplementation(async (channel: string, callback: (event: unknown) => void) => {
      if (channel === "external-agent://stdout") stdout = callback as typeof stdout
      return jest.fn()
    })
    const feed = (frame: Record<string, unknown>) =>
      stdout?.({ payload: { agentId: "stub-process", data: JSON.stringify(frame) } })

    mockInvoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "check_command_exists") return true
      if (command === "spawn_external_agent") return "stub-process"
      if (command !== "send_to_external_agent") return undefined
      const message = JSON.parse(String(args?.message)) as {
        id?: number
        method?: string
        result?: Record<string, unknown>
      }
      if (message.method === "initialize") {
        queueMicrotask(() =>
          feed({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {},
              agentInfo: { name: "stub-acp", version: "1" },
            },
          })
        )
      } else if (message.method === "session/new") {
        queueMicrotask(() =>
          feed({ jsonrpc: "2.0", id: message.id, result: { sessionId: "stub-session" } })
        )
      } else if (message.method === "session/prompt") {
        promptRequestId = message.id
        queueMicrotask(() =>
          feed({
            jsonrpc: "2.0",
            id: 900,
            method: "session/request_permission",
            params: {
              sessionId: "stub-session",
              toolCall: { toolCallId: "tool-1", title: "Edit file", rawInput: { path: "a.ts" } },
              options: [
                { optionId: "allow", name: "Allow once", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
          })
        )
      } else if (message.id === 900 && message.result) {
        permissionResponse = message.result
        queueMicrotask(() => {
          feed({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "stub-session",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "done" },
              },
            },
          })
          feed({
            jsonrpc: "2.0",
            id: promptRequestId,
            result: { stopReason: "end_turn" },
          })
        })
      }
      return undefined
    })

    const config = {
      ...DEFAULT_RESOLVED_CONFIG,
      cwd: process.cwd(),
      agentBackend: "codex" as const,
    }
    const renderTui = jest.fn(
      async ({
        createExternalSession,
      }: {
        // The launcher hands over BOTH factories now and lets the TUI route by
        // the live `agentBackend`, so `/backend` can switch mid-session.
        createExternalSession: (params: { config: typeof config }) => AgentSession
      }) => {
        const session = createExternalSession({ config })
        let state = createInitialState(config, "integration-session")
        const dispatch = (action: Parameters<typeof tuiReducer>[1]) => {
          state = tuiReducer(state, action)
        }
        const gate = createGateController((req) =>
          dispatch({
            type: "OVERLAY_OPEN",
            overlay: {
              kind: "permission",
              req,
              choices: DEFAULT_PERMISSION_CHOICES,
              index: 0,
            },
          })
        )
        const turn = runTurn({ session, prompt: "edit", dispatch, gate: gate.responder })
        // The turn resolves the whole Cognia context and starts the tool host
        // before it reaches the agent, and that work is real IO, not a fixed
        // number of microtasks. Counting ticks made this assert a race: too few
        // and the overlay had not opened, and no number is right on every
        // machine. Wait for the state, and let the clock only bound the failure.
        const deadline = Date.now() + 20_000
        while (state.overlay?.kind !== "permission" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(
          expect.arrayContaining(["spawn_external_agent", "send_to_external_agent"])
        )
        expect(state.overlay).toMatchObject({ kind: "permission", req: { toolName: "Edit file" } })
        gate.resolve({ decision: "allow" })
        dispatch({ type: "OVERLAY_CLOSE" })
        await expect(turn).resolves.toMatchObject({ ok: true })
        expect(state.cells).toEqual(
          expect.arrayContaining([expect.objectContaining({ kind: "assistant", raw: "done" })])
        )
        await session.close()
        return 0
      }
    )

    await expect(
      chatCommand(parseArgv(["chat", "--backend", "codex"]), {
        loadConfig: () => config,
        isTty: () => true,
        renderTui: renderTui as never,
      })
    ).resolves.toBe(0)
    expect(renderTui).toHaveBeenCalled()
    expect(permissionResponse).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
  })
})
