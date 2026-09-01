/**
 * Tests for the multiplexer detection and integration module.
 */

import {
  detectMultiplexerFromEnv,
  parseTmuxSessionList,
  parseTmuxWindowList,
  buildTmuxAttachCommand,
  buildTmuxNewSessionCommand,
  buildTmuxDetachCommand,
  detectMultiplexer,
  listTmuxSessions,
  listTmuxWindows,
} from "./multiplexer"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

import { transport } from "@/lib/tauri"
const mockCall = transport.call as jest.MockedFunction<typeof transport.call>

describe("multiplexer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCall.mockRejectedValue(new Error("no transport"))
  })

  describe("detectMultiplexerFromEnv", () => {
    it("detects tmux from $TMUX", () => {
      const result = detectMultiplexerFromEnv({
        TMUX: "/tmp/tmux-1000/default,12345,0",
      })
      expect(result.type).toBe("tmux")
      expect(result.socketPath).toBe("/tmp/tmux-1000/default")
    })

    it("detects screen from $STY", () => {
      const result = detectMultiplexerFromEnv({
        STY: "12345.pts-0.hostname",
      })
      expect(result.type).toBe("screen")
      expect(result.socketPath).toBe("12345.pts-0.hostname")
    })

    it("detects zellij from $ZELLIJ", () => {
      const result = detectMultiplexerFromEnv({
        ZELLIJ: "/tmp/zellij-1000/session-1",
        ZELLIJ_VERSION: "0.39.0",
      })
      expect(result.type).toBe("zellij")
      expect(result.socketPath).toBe("/tmp/zellij-1000/session-1")
      expect(result.version).toBe("0.39.0")
    })

    it("returns none when no multiplexer env vars set", () => {
      const result = detectMultiplexerFromEnv({})
      expect(result.type).toBe("none")
      expect(result.socketPath).toBeNull()
    })

    it("prioritizes tmux over screen when both are set", () => {
      const result = detectMultiplexerFromEnv({
        TMUX: "/tmp/tmux-1000/default,12345,0",
        STY: "12345.pts-0.hostname",
      })
      expect(result.type).toBe("tmux")
    })
  })

  describe("parseTmuxSessionList", () => {
    it("parses standard tmux list-sessions output", () => {
      const output = [
        "main: 3 windows (created Mon Aug  5 10:30:00 2024) (attached)",
        "dev: 1 windows (created Mon Aug  5 11:00:00 2024)",
      ].join("\n")

      const sessions = parseTmuxSessionList(output)
      expect(sessions).toHaveLength(2)
      expect(sessions[0].name).toBe("main")
      expect(sessions[0].windowCount).toBe(3)
      expect(sessions[0].attached).toBe(true)
      expect(sessions[1].name).toBe("dev")
      expect(sessions[1].windowCount).toBe(1)
      expect(sessions[1].attached).toBe(false)
    })

    it("returns empty array for empty input", () => {
      expect(parseTmuxSessionList("")).toEqual([])
      expect(parseTmuxSessionList("  ")).toEqual([])
    })

    it("skips malformed lines", () => {
      const output = [
        "good: 2 windows (created Mon Aug  5 10:00:00 2024)",
        "bad line that doesn't match",
        "also-good: 1 windows (created Mon Aug  5 11:00:00 2024) (attached)",
      ].join("\n")

      const sessions = parseTmuxSessionList(output)
      expect(sessions).toHaveLength(2)
    })

    it("handles single window (singular)", () => {
      const output = "test: 1 window (created Mon Aug  5 10:00:00 2024)"
      const sessions = parseTmuxSessionList(output)
      expect(sessions).toHaveLength(1)
      expect(sessions[0].windowCount).toBe(1)
    })
  })

  describe("parseTmuxWindowList", () => {
    it("parses standard tmux list-windows output", () => {
      const output = [
        "0: zsh* (1 panes) [200x50] (active)",
        "1: vim- (2 panes) [200x50]",
        "2: server (1 panes) [200x50]",
      ].join("\n")

      const windows = parseTmuxWindowList(output)
      expect(windows).toHaveLength(3)
      expect(windows[0].index).toBe(0)
      expect(windows[0].name).toBe("zsh")
      expect(windows[0].active).toBe(true)
      expect(windows[0].paneCount).toBe(1)
      expect(windows[1].name).toBe("vim")
      expect(windows[1].active).toBe(false)
      expect(windows[1].paneCount).toBe(2)
    })

    it("returns empty array for empty input", () => {
      expect(parseTmuxWindowList("")).toEqual([])
    })
  })

  describe("buildTmuxAttachCommand", () => {
    it("builds attach command for simple session name", () => {
      expect(buildTmuxAttachCommand("main")).toBe("tmux attach-session -t main")
    })

    it("quotes session names with special characters", () => {
      expect(buildTmuxAttachCommand("my session")).toBe("tmux attach-session -t 'my session'")
    })

    it("escapes single quotes in session names", () => {
      expect(buildTmuxAttachCommand("it's")).toBe("tmux attach-session -t 'it'\\''s'")
    })
  })

  describe("buildTmuxNewSessionCommand", () => {
    it("builds new-session with name", () => {
      expect(buildTmuxNewSessionCommand("dev")).toBe("tmux new-session -s dev")
    })

    it("builds new-session without name", () => {
      expect(buildTmuxNewSessionCommand()).toBe("tmux new-session")
    })
  })

  describe("buildTmuxDetachCommand", () => {
    it("returns the detach command", () => {
      expect(buildTmuxDetachCommand()).toBe("tmux detach-client")
    })
  })

  // The three probes below run against whichever host the routed transport is
  // pointed at. They used to short-circuit on `!isTauri()`, which made a
  // browser paired to a Host report "no tmux" for a machine that had it.
  describe("detectMultiplexer", () => {
    it("asks the routed transport, whatever host it points at", async () => {
      mockCall.mockResolvedValue({
        type: "tmux",
        socketPath: "/tmp/tmux-501/default",
        version: "3.4",
      })

      await expect(detectMultiplexer()).resolves.toEqual({
        type: "tmux",
        socketPath: "/tmp/tmux-501/default",
        version: "3.4",
      })
      expect(mockCall).toHaveBeenCalledWith("terminal_detect_multiplexer")
    })

    it("reads a rejected call as 'no multiplexer', not as a failure", async () => {
      await expect(detectMultiplexer()).resolves.toEqual({
        type: "none",
        socketPath: null,
        version: null,
      })
    })
  })

  describe("listTmuxSessions", () => {
    it("returns the host's sessions", async () => {
      const sessions = [{ name: "main", windowCount: 2, attached: true, createdAt: 1 }]
      mockCall.mockResolvedValue(sessions)

      await expect(listTmuxSessions()).resolves.toEqual(sessions)
      expect(mockCall).toHaveBeenCalledWith("terminal_list_tmux_sessions")
    })

    it("returns empty when the host cannot answer", async () => {
      await expect(listTmuxSessions()).resolves.toEqual([])
    })
  })

  describe("listTmuxWindows", () => {
    it("passes the session name through to the host", async () => {
      const windows = [{ index: 0, name: "zsh", active: true, paneCount: 1 }]
      mockCall.mockResolvedValue(windows)

      await expect(listTmuxWindows("main")).resolves.toEqual(windows)
      expect(mockCall).toHaveBeenCalledWith("terminal_list_tmux_windows", { sessionName: "main" })
    })

    it("returns empty when the host cannot answer", async () => {
      await expect(listTmuxWindows("main")).resolves.toEqual([])
    })
  })
})
