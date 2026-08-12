/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createSession } from "@/lib/db/sessions"
import {
  buildWorkingSetManifestEntries,
  runWorkingSetTool,
  WORKING_SET_TOOL_NAME,
} from "./working-set-tool"

describe("working_set host tool", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("publishes one bounded core-tool contract", () => {
    const [entry] = buildWorkingSetManifestEntries()
    expect(entry).toMatchObject({
      name: WORKING_SET_TOOL_NAME,
      pluginId: "cognia-working-set-builtin",
    })
    expect(entry?.jsonSchema).toMatchObject({
      required: ["action"],
      properties: { action: { enum: ["get", "upsert", "resolve", "remove"] } },
    })
  })

  it("uses the shared CAS mutation service for get, upsert, resolve, and remove", async () => {
    const session = await createSession({ title: "Tool" })
    const initial = await runWorkingSetTool({ action: "get" }, { sessionId: session.id })
    expect(initial).toMatchObject({ ok: true, workingSet: { revision: 0, entries: [] } })

    const created = await runWorkingSetTool(
      {
        action: "upsert",
        expectedRevision: 0,
        entry: {
          id: "question-1",
          kind: "open-question",
          summary: "Ask jane@example.com for approval",
          origin: "agent",
          refs: [],
        },
      },
      { sessionId: session.id }
    )
    expect(created).toMatchObject({
      ok: true,
      workingSet: {
        revision: 1,
        entries: [{ id: "question-1", summary: "Ask <EMAIL_001> for approval" }],
      },
    })

    const conflict = await runWorkingSetTool(
      { action: "resolve", expectedRevision: 0, entryId: "question-1" },
      { sessionId: session.id }
    )
    expect(conflict).toMatchObject({ ok: false, code: "revision_conflict", revision: 1 })

    const resolved = await runWorkingSetTool(
      { action: "resolve", expectedRevision: 1, entryId: "question-1" },
      { sessionId: session.id }
    )
    expect(resolved).toMatchObject({
      ok: true,
      workingSet: { revision: 2, entries: [{ status: "resolved" }] },
    })

    const removed = await runWorkingSetTool(
      { action: "remove", expectedRevision: 2, entryId: "question-1" },
      { sessionId: session.id }
    )
    expect(removed).toMatchObject({ ok: true, workingSet: { revision: 3, entries: [] } })
  })

  it("requires expectedRevision for mutations", async () => {
    const session = await createSession({ title: "Required revision" })
    await expect(
      runWorkingSetTool(
        { action: "upsert", entry: { kind: "fact", summary: "x", origin: "agent" } },
        { sessionId: session.id }
      )
    ).resolves.toMatchObject({ ok: false, code: "invalid_arguments" })
  })
})
