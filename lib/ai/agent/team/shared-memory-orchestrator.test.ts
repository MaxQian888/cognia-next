/**
 * Shared-memory orchestrator tests.
 *
 * Exercises the PII gate, version bumping, hook fan-out, and the task-result
 * convenience helper. The plugin lifecycle hooks are mocked so we don't need
 * the plugin runtime.
 */

import "fake-indexeddb/auto"

const dispatchOnSharedMemoryWrite = jest.fn()
const dispatchOnSharedMemoryDelete = jest.fn()

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginLifecycleHooks: jest.fn(() => ({
    dispatchOnSharedMemoryWrite,
    dispatchOnSharedMemoryDelete,
  })),
}))

import {
  SharedMemoryPiiError,
  autoPublishTaskResult,
  clearTeamMemory,
  deleteEntry,
  publishEntry,
} from "./shared-memory-orchestrator"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

const writer = { id: "w1", name: "Worker 1" }
const task = { id: "task-1", title: "Test task" }
const team = { id: "team-1" }

describe("shared-memory-orchestrator", () => {
  beforeEach(() => {
    useAgentTeamStore.getState().reset()
    dispatchOnSharedMemoryWrite.mockReset()
    dispatchOnSharedMemoryDelete.mockReset()
  })

  describe("publishEntry", () => {
    it("writes a clean string entry, fires onSharedMemoryWrite, and stamps version=1", () => {
      const entry = publishEntry({
        teamId: team.id,
        key: "note",
        value: "team plan ok",
        writer,
      })
      expect(entry.version).toBe(1)
      expect(entry.writtenBy).toBe(writer.id)
      expect(entry.writerName).toBe(writer.name)
      expect(useAgentTeamStore.getState().sharedMemory[team.id]?.note).toBeDefined()
      expect(dispatchOnSharedMemoryWrite).toHaveBeenCalledWith({
        teamId: team.id,
        key: "note",
        writerId: writer.id,
      })
    })

    it("bumps version on each subsequent write to the same key", () => {
      publishEntry({ teamId: team.id, key: "k", value: "v1", writer })
      const second = publishEntry({ teamId: team.id, key: "k", value: "v2", writer })
      expect(second.version).toBe(2)
      const third = publishEntry({ teamId: team.id, key: "k", value: "v3", writer })
      expect(third.version).toBe(3)
    })

    it("rejects values that leak PII (email)", () => {
      expect(() =>
        publishEntry({
          teamId: team.id,
          key: "leak",
          value: "Please reach me at example@example.com tomorrow",
          writer,
        })
      ).toThrow(SharedMemoryPiiError)
      // Store untouched.
      expect(useAgentTeamStore.getState().sharedMemory[team.id]).toBeUndefined()
      expect(dispatchOnSharedMemoryWrite).not.toHaveBeenCalled()
    })

    it("rejects values that contain API keys", () => {
      expect(() =>
        publishEntry({
          teamId: team.id,
          key: "leak",
          value: "Use sk-1234567890abcdefghijklmnop for the request",
          writer,
        })
      ).toThrow(SharedMemoryPiiError)
    })

    it("accepts non-string values without running the PII gate", () => {
      const entry = publishEntry({
        teamId: team.id,
        key: "structured",
        value: { totalRows: 42, tags: ["green"] },
        writer,
      })
      expect(entry.version).toBe(1)
      expect(entry.value).toEqual({ totalRows: 42, tags: ["green"] })
    })

    it("threads optional tags / readableBy / expiresAt through to the entry", () => {
      const expiresAt = new Date(Date.now() + 3600 * 1000)
      const entry = publishEntry({
        teamId: team.id,
        key: "scoped",
        value: "shared",
        writer,
        tags: ["a", "b"],
        readableBy: ["v2"],
        expiresAt,
      })
      expect(entry.tags).toEqual(["a", "b"])
      expect(entry.readableBy).toEqual(["v2"])
      expect(entry.expiresAt).toBe(expiresAt)
    })
  })

  describe("deleteEntry", () => {
    it("removes the entry and fires onSharedMemoryDelete", () => {
      publishEntry({ teamId: team.id, key: "k", value: "v", writer })
      deleteEntry(team.id, "k")
      expect(useAgentTeamStore.getState().sharedMemory[team.id]?.k).toBeUndefined()
      expect(dispatchOnSharedMemoryDelete).toHaveBeenCalledWith({
        teamId: team.id,
        key: "k",
      })
    })

    it("fires the delete hook even when the entry was already absent", () => {
      deleteEntry(team.id, "nope")
      expect(dispatchOnSharedMemoryDelete).toHaveBeenCalled()
    })
  })

  describe("clearTeamMemory", () => {
    it("drops every entry for the team", () => {
      publishEntry({ teamId: team.id, key: "a", value: "1", writer })
      publishEntry({ teamId: team.id, key: "b", value: "2", writer })
      clearTeamMemory(team.id)
      expect(useAgentTeamStore.getState().sharedMemory[team.id]).toBeUndefined()
    })
  })

  describe("autoPublishTaskResult", () => {
    it("returns undefined for empty / whitespace-only results", () => {
      expect(autoPublishTaskResult(team, task, "", writer)).toBeUndefined()
      expect(autoPublishTaskResult(team, task, "   \n  ", writer)).toBeUndefined()
      expect(dispatchOnSharedMemoryWrite).not.toHaveBeenCalled()
    })

    it("returns undefined when the result trips the PII gate", () => {
      const out = autoPublishTaskResult(
        team,
        task,
        "Final report — contact alice@example.org",
        writer
      )
      expect(out).toBeUndefined()
      expect(dispatchOnSharedMemoryWrite).not.toHaveBeenCalled()
    })

    it("publishes a clean result under the canonical task:<id> key with task tags", () => {
      const entry = autoPublishTaskResult(team, task, "Result ready.", writer)
      expect(entry).toBeDefined()
      expect(entry!.key).toBe(`task:${task.id}`)
      expect(entry!.tags).toEqual([`task:${task.id}`, `taskTitle:${task.title}`])
      const stored = useAgentTeamStore.getState().sharedMemory[team.id]?.[`task:${task.id}`]
      expect(stored).toEqual(entry)
    })
  })
})
