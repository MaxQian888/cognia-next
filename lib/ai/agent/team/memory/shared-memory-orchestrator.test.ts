/** @jest-environment jsdom */
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
  readDependencyResults,
  syncSharedMemoryFromAdapter,
} from "./shared-memory-orchestrator"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import {
  registerSharedMemoryAdapter,
  __resetSharedMemoryAdaptersForTesting,
} from "@/lib/plugin/registries/shared-memory-adapter-registry"
import type {
  PluginSharedMemoryAdapterDef,
  SharedMemoryAdapterChangeSet,
} from "@/types/plugin/plugin-shared-memory-adapter"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

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

  describe("readDependencyResults", () => {
    it("returns [] for an empty dependency list without touching the store", () => {
      expect(readDependencyResults(team.id, [])).toEqual([])
    })

    it("reads published task results in input order and recovers title + writer", () => {
      autoPublishTaskResult(
        team,
        { id: "dep-a", title: "Research" },
        "Found three options.",
        writer
      )
      autoPublishTaskResult(team, { id: "dep-b", title: "Draft" }, "Drafted the summary.", {
        id: "w2",
        name: "Worker 2",
      })
      const out = readDependencyResults(team.id, ["dep-b", "dep-a"])
      expect(out).toEqual([
        {
          taskId: "dep-b",
          taskTitle: "Draft",
          writerName: "Worker 2",
          value: "Drafted the summary.",
        },
        {
          taskId: "dep-a",
          taskTitle: "Research",
          writerName: "Worker 1",
          value: "Found three options.",
        },
      ])
    })

    it("skips dependency ids with no blackboard entry", () => {
      autoPublishTaskResult(team, { id: "dep-a", title: "Research" }, "Only this one.", writer)
      const out = readDependencyResults(team.id, ["missing", "dep-a"])
      expect(out).toHaveLength(1)
      expect(out[0].taskId).toBe("dep-a")
    })
  })

  describe("shared-memory adapter mirror + reverse sync", () => {
    const ADAPTER_ID = "fake:mem"

    const seedTeamWithAdapter = (): string => {
      const created = useAgentTeamStore
        .getState()
        .createTeam({ name: "Mirror", task: "t", config: { sharedMemoryAdapterId: ADAPTER_ID } })
      return created.id
    }

    const makeAdapter = (
      over: Partial<PluginSharedMemoryAdapterDef> = {}
    ): PluginSharedMemoryAdapterDef => ({
      id: ADAPTER_ID,
      name: "Fake",
      write: jest.fn(async () => {}),
      read: jest.fn(async () => undefined),
      listChanges: jest.fn(async (): Promise<SharedMemoryAdapterChangeSet> => ({
        entries: [],
        cursor: 0,
      })),
      delete: jest.fn(async () => {}),
      ...over,
    })

    beforeEach(() => {
      __resetSharedMemoryAdaptersForTesting()
    })

    it("mirrors a publish to the configured adapter (fire-and-forget)", async () => {
      const adapter = makeAdapter()
      registerSharedMemoryAdapter(ADAPTER_ID, adapter, { pluginId: "fake" })
      const teamId = seedTeamWithAdapter()

      publishEntry({ teamId, key: "k", value: "clean value", writer })
      await flushMicrotasks()
      expect(adapter.write).toHaveBeenCalledTimes(1)
      expect((adapter.write as jest.Mock).mock.calls[0][0]).toBe(teamId)
    })

    it("mirrors a delete to the configured adapter", async () => {
      const adapter = makeAdapter()
      registerSharedMemoryAdapter(ADAPTER_ID, adapter, { pluginId: "fake" })
      const teamId = seedTeamWithAdapter()

      publishEntry({ teamId, key: "k", value: "v", writer })
      await flushMicrotasks()
      deleteEntry(teamId, "k")
      await flushMicrotasks()
      expect(adapter.delete).toHaveBeenCalledWith(teamId, "k")
    })

    it("reverse sync does not echo back to the adapter (no mirror write)", async () => {
      const adapter = makeAdapter({
        listChanges: jest.fn(async () => ({
          entries: [
            {
              key: "fromRemote",
              value: "remote value",
              writtenBy: "remote",
              writtenAt: new Date(),
              version: 1,
            },
          ],
          cursor: 1,
        })),
      })
      registerSharedMemoryAdapter(ADAPTER_ID, adapter, { pluginId: "fake" })
      const teamId = seedTeamWithAdapter()

      await syncSharedMemoryFromAdapter(teamId)
      await flushMicrotasks()
      // The pulled entry is written via the store directly, never through
      // publishEntry, so it must NOT trigger a mirror write back to the adapter.
      expect(adapter.write).not.toHaveBeenCalled()
    })

    it("syncSharedMemoryFromAdapter pulls higher-version entries and skips lower", async () => {
      const remoteEntries: SharedMemoryEntry[] = [
        {
          key: "fromRemote",
          value: "remote value",
          writtenBy: "remote",
          writtenAt: new Date(),
          version: 3,
        },
        {
          key: "stale",
          value: "old remote",
          writtenBy: "remote",
          writtenAt: new Date(),
          version: 1,
        },
      ]
      const adapter = makeAdapter({
        listChanges: jest.fn(async () => ({ entries: remoteEntries, cursor: 7 })),
      })
      registerSharedMemoryAdapter(ADAPTER_ID, adapter, { pluginId: "fake" })
      const teamId = seedTeamWithAdapter()

      // Local "stale" is newer (v2) than the remote (v1) → local wins.
      useAgentTeamStore.getState().writeSharedMemory(teamId, "stale", {
        key: "stale",
        value: "local newer",
        writtenBy: writer.id,
        writtenAt: new Date(),
        version: 2,
      })

      const { pulled } = await syncSharedMemoryFromAdapter(teamId)
      expect(pulled).toBe(1) // only fromRemote written back
      const mem = useAgentTeamStore.getState().sharedMemory[teamId]
      expect(mem?.fromRemote?.value).toBe("remote value")
      expect(mem?.fromRemote?.writerName).toBe(`${ADAPTER_ID}:sync`)
      expect(mem?.stale?.value).toBe("local newer") // unchanged
      // Cursor advanced.
      expect(useAgentTeamStore.getState().lastAdapterSyncVersion[teamId]?.[ADAPTER_ID]).toBe(7)
    })

    it("syncSharedMemoryFromAdapter is a no-op when no adapter is configured", async () => {
      const created = useAgentTeamStore.getState().createTeam({ name: "NoAdapter", task: "t" })
      const result = await syncSharedMemoryFromAdapter(created.id)
      expect(result).toEqual({ pulled: 0 })
    })
  })
})
