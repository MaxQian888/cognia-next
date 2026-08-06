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
  isTauri: jest.fn(() => false),
}))

import { isTauri } from "@/lib/tauri"
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

describe("multiplexer", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
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

  describe("detectMultiplexer (Tauri integration)", () => {
    it("returns none when not in Tauri", async () => {
      const result = await detectMultiplexer()
      expect(result.type).toBe("none")
    })
  })

  describe("listTmuxSessions (Tauri integration)", () => {
    it("returns empty when not in Tauri", async () => {
      const result = await listTmuxSessions()
      expect(result).toEqual([])
    })
  })

  describe("listTmuxWindows (Tauri integration)", () => {
    it("returns empty when not in Tauri", async () => {
      const result = await listTmuxWindows("main")
      expect(result).toEqual([])
    })
  })
})
