/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createSession } from "@/lib/db/sessions"
import {
  mutateSessionWorkingSet,
  readSessionWorkingSet,
  renderWorkingSetForCompaction,
  WorkingSetConflictError,
} from "./working-set"

describe("session working set", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("redacts and CAS-updates bounded entries through one mutation seam", async () => {
    const session = await createSession({ title: "Working set" })
    const created = await mutateSessionWorkingSet({
      sessionId: session.id,
      expectedRevision: 0,
      action: "upsert",
      entry: {
        id: "fact-1",
        kind: "fact",
        summary: "Contact jane@example.com after the build",
        origin: "agent",
        refs: [{ namespace: "cognia", type: "execution-run", id: "run-1" }],
      },
      now: 1_000,
    })

    expect(created.revision).toBe(1)
    expect(created.entries[0]).toMatchObject({
      id: "fact-1",
      summary: "Contact <EMAIL_001> after the build",
      status: "active",
    })
    await expect(
      mutateSessionWorkingSet({
        sessionId: session.id,
        expectedRevision: 0,
        action: "resolve",
        entryId: "fact-1",
      })
    ).rejects.toBeInstanceOf(WorkingSetConflictError)

    const resolved = await mutateSessionWorkingSet({
      sessionId: session.id,
      expectedRevision: 1,
      action: "resolve",
      entryId: "fact-1",
      now: 2_000,
    })
    expect(resolved.entries[0]?.status).toBe("resolved")
    await expect(readSessionWorkingSet(session.id)).resolves.toEqual(resolved)
  })

  it("removes entries and rejects unsafe or oversized input", async () => {
    const session = await createSession({ title: "Bounds" })
    await expect(
      mutateSessionWorkingSet({
        sessionId: session.id,
        expectedRevision: 0,
        action: "upsert",
        entry: {
          kind: "fact",
          summary: "x".repeat(513),
          origin: "user",
          refs: [],
        },
      })
    ).rejects.toThrow("512")
    await expect(
      mutateSessionWorkingSet({
        sessionId: session.id,
        expectedRevision: 0,
        action: "upsert",
        entry: {
          kind: "resource",
          summary: "Invalid ref",
          origin: "user",
          refs: [{ namespace: "", type: "file", id: "a" }],
        },
      })
    ).rejects.toThrow("resource reference")
    await expect(
      mutateSessionWorkingSet({
        sessionId: session.id,
        expectedRevision: 0,
        action: "upsert",
        entry: {
          id: "unsafe-ref",
          kind: "resource",
          summary: "Sensitive ref",
          origin: "user",
          refs: [{ namespace: "cognia", type: "file", id: "jane@example.com" }],
        },
      })
    ).rejects.toThrow("PII gate")

    const created = await mutateSessionWorkingSet({
      sessionId: session.id,
      expectedRevision: 0,
      action: "upsert",
      entry: { kind: "decision", summary: "Use the existing runner", origin: "user", refs: [] },
    })
    const removed = await mutateSessionWorkingSet({
      sessionId: session.id,
      expectedRevision: created.revision,
      action: "remove",
      entryId: created.entries[0]!.id,
    })
    expect(removed.entries).toEqual([])
  })

  it("renders only active entries within the durable-instruction budget", async () => {
    const session = await createSession({ title: "Compaction" })
    const first = await mutateSessionWorkingSet({
      sessionId: session.id,
      expectedRevision: 0,
      action: "upsert",
      entry: {
        id: "open",
        kind: "open-question",
        summary: "Verify the migration",
        origin: "agent",
        refs: [],
      },
    })
    await mutateSessionWorkingSet({
      sessionId: session.id,
      expectedRevision: first.revision,
      action: "upsert",
      entry: {
        id: "done",
        kind: "fact",
        summary: "Old resolved fact",
        origin: "agent",
        refs: [],
        status: "resolved",
      },
    })

    const rendered = renderWorkingSetForCompaction(await readSessionWorkingSet(session.id))
    expect(rendered).toContain("Verify the migration")
    expect(rendered).not.toContain("Old resolved fact")
    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(8 * 1024)
  })

  it("defensively rejects an unsafe persisted working set before prompt rendering", () => {
    expect(() =>
      renderWorkingSetForCompaction({
        contractVersion: 1,
        revision: 1,
        updatedAt: 20,
        entries: [
          {
            id: "unsafe",
            kind: "resource",
            summary: "Inspect the resource",
            status: "active",
            origin: "agent",
            refs: [{ namespace: "cognia", type: "file", id: "jane@example.com" }],
            createdAt: 10,
            updatedAt: 20,
          },
        ],
      })
    ).toThrow("PII gate")
  })
})
