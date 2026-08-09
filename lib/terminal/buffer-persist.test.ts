/**
 * Tests for the buffer persistence orchestration layer.
 */

import {
  dumpBuffer,
  loadBuffer,
  pruneBuffers,
  hasPersistedBuffer,
  MAX_BUFFER_SIZE_BYTES,
} from "./buffer-persist"

// Mock the tauri check
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

// Mock the invoke function
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { invoke } from "@tauri-apps/api/core"

const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockInvoke = invoke as jest.MockedFunction<typeof invoke>

describe("buffer-persist", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsTauri.mockReturnValue(false)
  })

  describe("dumpBuffer", () => {
    it("returns failure when not in Tauri", async () => {
      const result = await dumpBuffer("s1", "content")
      expect(result.success).toBe(false)
      expect(result.error).toContain("Tauri")
    })

    it("returns failure for empty content", async () => {
      mockIsTauri.mockReturnValue(true)
      const result = await dumpBuffer("s1", "")
      expect(result.success).toBe(false)
      expect(result.error).toContain("Empty")
    })

    it("calls invoke with correct args in Tauri", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockResolvedValue({ size_bytes: 1024 })

      const result = await dumpBuffer("session-1", "buffer content")

      expect(result.success).toBe(true)
      expect(result.sizeBytes).toBe(1024)
      expect(mockInvoke).toHaveBeenCalledWith("terminal_dump_buffer", {
        sessionId: "session-1",
        content: "buffer content",
      })
    })

    it("truncates content exceeding MAX_BUFFER_SIZE_BYTES", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockResolvedValue({ size_bytes: MAX_BUFFER_SIZE_BYTES })

      const longContent = "x".repeat(MAX_BUFFER_SIZE_BYTES + 1000)
      await dumpBuffer("s1", longContent)

      const callArgs = mockInvoke.mock.calls[0][1] as { content: string }
      expect(callArgs.content.length).toBe(MAX_BUFFER_SIZE_BYTES)
    })

    it("handles invoke rejection gracefully", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockRejectedValue(new Error("Disk full"))

      const result = await dumpBuffer("s1", "data")
      expect(result.success).toBe(false)
      expect(result.error).toBe("Disk full")
    })
  })

  describe("loadBuffer", () => {
    it("returns not found when not in Tauri", async () => {
      const result = await loadBuffer("s1")
      expect(result.found).toBe(false)
      expect(result.content).toBeNull()
    })

    it("returns buffer content when found", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockResolvedValue({ found: true, content: "line1\nline2\nline3" })

      const result = await loadBuffer("session-1")

      expect(result.found).toBe(true)
      expect(result.content).toBe("line1\nline2\nline3")
      expect(result.lineCount).toBe(3)
    })

    it("returns not found when buffer doesn't exist", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockResolvedValue({ found: false, content: null })

      const result = await loadBuffer("missing")
      expect(result.found).toBe(false)
      expect(result.content).toBeNull()
      expect(result.lineCount).toBe(0)
    })

    it("handles invoke rejection gracefully", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockRejectedValue(new Error("IO error"))

      const result = await loadBuffer("s1")
      expect(result.found).toBe(false)
    })
  })

  describe("pruneBuffers", () => {
    it("returns zeros when not in Tauri", async () => {
      const result = await pruneBuffers()
      expect(result.removedCount).toBe(0)
      expect(result.freedBytes).toBe(0)
    })

    it("calls invoke and returns prune stats", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockResolvedValue({ removed_count: 3, freed_bytes: 5120 })

      const result = await pruneBuffers()
      expect(result.removedCount).toBe(3)
      expect(result.freedBytes).toBe(5120)
    })

    it("handles invoke rejection gracefully", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockRejectedValue(new Error("Permission denied"))

      const result = await pruneBuffers()
      expect(result.removedCount).toBe(0)
      expect(result.freedBytes).toBe(0)
    })
  })

  describe("hasPersistedBuffer", () => {
    it("returns false when not in Tauri", async () => {
      expect(await hasPersistedBuffer("s1")).toBe(false)
    })

    it("returns true when buffer exists", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockResolvedValue(true)

      expect(await hasPersistedBuffer("s1")).toBe(true)
    })

    it("returns false when buffer doesn't exist", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockResolvedValue(false)

      expect(await hasPersistedBuffer("missing")).toBe(false)
    })

    it("handles invoke rejection gracefully", async () => {
      mockIsTauri.mockReturnValue(true)
      mockInvoke.mockRejectedValue(new Error("error"))

      expect(await hasPersistedBuffer("s1")).toBe(false)
    })
  })
})
