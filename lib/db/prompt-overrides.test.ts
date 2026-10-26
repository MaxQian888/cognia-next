/** @jest-environment jsdom */
// Real Dexie transactions and the unique compound index run against
// fake-indexeddb; nothing below the CRUD layer is mocked.

import {
  PROMPT_REVISION_HISTORY_LIMIT,
  PromptOverrideConflictError,
  deletePromptOverrideBinding,
  discardPromptOverrideDraft,
  getPromptOverrideBinding,
  getPromptOverrideRevision,
  isPromptOverrideConflict,
  listPromptOverrideBindings,
  listPromptOverrideBindingsFor,
  listPromptOverrideRevisions,
  onPromptOverridesChanged,
  publishPromptOverride,
  resetPromptOverride,
  savePromptOverrideDraft,
} from "./prompt-overrides"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const account = { scope: "account" as const, targetId: "" }
let mutation = 0
const write = (body: string, expectedRev: number, extra: Record<string, unknown> = {}) => ({
  promptId: "generation.title.chat",
  target: account,
  body,
  contractVersion: 1,
  baseDigest: "sha256:base",
  expectedRev,
  mutationId: `m${++mutation}`,
  origin: "editor" as const,
  ...extra,
})

describe("publishPromptOverride", () => {
  it("creates the binding, activates an immutable revision and bumps rev", async () => {
    const binding = await publishPromptOverride(write("Title it.", 0))
    expect(binding).toMatchObject({ rev: 1, scope: "account", targetId: "", draftRevisionId: null })
    const active = await getPromptOverrideRevision(binding.activeRevisionId!)
    expect(active).toMatchObject({ kind: "published", body: "Title it.", parentId: null })

    const second = await publishPromptOverride(write("Title it better.", 1))
    expect(second.rev).toBe(2)
    expect(second.id).toBe(binding.id)
    const next = await getPromptOverrideRevision(second.activeRevisionId!)
    expect(next?.parentId).toBe(binding.activeRevisionId)
    // The first revision is history, untouched.
    expect((await getPromptOverrideRevision(binding.activeRevisionId!))?.body).toBe("Title it.")
  })

  it("rejects a stale rev instead of overwriting a concurrent publish", async () => {
    await publishPromptOverride(write("A", 0))
    await expect(publishPromptOverride(write("B", 0))).rejects.toBeInstanceOf(
      PromptOverrideConflictError
    )
    const error = await publishPromptOverride(write("B", 0)).catch((e: unknown) => e)
    expect(isPromptOverrideConflict(error)).toBe(true)
    expect((error as PromptOverrideConflictError).currentRev).toBe(1)
  })

  it("treats a replayed mutation id as already applied", async () => {
    const input = write("Once", 0)
    const first = await publishPromptOverride(input)
    const replay = await publishPromptOverride(input)
    expect(replay.rev).toBe(first.rev)
    expect(await listPromptOverrideRevisions(first.id)).toHaveLength(1)
  })

  it("keeps the slots of different scopes and targets apart", async () => {
    await publishPromptOverride(write("account", 0))
    await publishPromptOverride(write("ws-a", 0, { target: { scope: "workspace", targetId: "a" } }))
    await publishPromptOverride(write("ws-b", 0, { target: { scope: "workspace", targetId: "b" } }))
    expect(await listPromptOverrideBindingsFor("generation.title.chat")).toHaveLength(3)
    // The account scope ignores whatever target id a caller passes.
    const viaAccount = await getPromptOverrideBinding("generation.title.chat", {
      scope: "account",
      targetId: "ignored",
    })
    expect(viaAccount?.targetId).toBe("")
  })
})

describe("drafts", () => {
  it("leaves the active revision alone and is consumed by publish", async () => {
    const published = await publishPromptOverride(write("live", 0))
    const drafted = await savePromptOverrideDraft(write("wip", 1))
    expect(drafted.activeRevisionId).toBe(published.activeRevisionId)
    expect((await getPromptOverrideRevision(drafted.draftRevisionId!))?.kind).toBe("draft")

    const replaced = await savePromptOverrideDraft(write("wip 2", 2))
    // The superseded draft was never active, so it is not kept as history.
    expect(await getPromptOverrideRevision(drafted.draftRevisionId!)).toBeUndefined()

    const next = await publishPromptOverride(write("wip 2", replaced.rev))
    expect(next.draftRevisionId).toBeNull()
    expect(await getPromptOverrideRevision(replaced.draftRevisionId!)).toBeUndefined()
  })

  it("can be discarded without touching the published body", async () => {
    const published = await publishPromptOverride(write("live", 0))
    const drafted = await savePromptOverrideDraft(write("wip", 1))
    const discarded = await discardPromptOverrideDraft({ ...write("", drafted.rev) })
    expect(discarded.draftRevisionId).toBeNull()
    expect(discarded.activeRevisionId).toBe(published.activeRevisionId)
  })
})

describe("resetPromptOverride", () => {
  it("returns the slot to inheritance and keeps the history", async () => {
    const published = await publishPromptOverride(write("live", 0))
    const reset = await resetPromptOverride({ ...write("", 1) })
    expect(reset.activeRevisionId).toBeNull()
    const history = await listPromptOverrideRevisions(reset.id)
    expect(history.map((row) => row.kind)).toEqual(["reset", "published"])
    expect(history[1].id).toBe(published.activeRevisionId)
  })
})

describe("history retention", () => {
  it("keeps the active revision plus the newest inactive ones", async () => {
    let rev = 0
    for (let i = 0; i < PROMPT_REVISION_HISTORY_LIMIT + 5; i++) {
      const binding = await publishPromptOverride(write(`v${i}`, rev, { now: 1_000 + i }))
      rev = binding.rev
    }
    const binding = (await getPromptOverrideBinding("generation.title.chat", account))!
    const rows = await listPromptOverrideRevisions(binding.id)
    expect(rows).toHaveLength(PROMPT_REVISION_HISTORY_LIMIT + 1)
    expect(rows[0].id).toBe(binding.activeRevisionId)
    expect(rows.at(-1)?.body).toBe("v4")
  })
})

describe("deletePromptOverrideBinding", () => {
  it("removes the binding and every revision, under the same rev check", async () => {
    const binding = await publishPromptOverride(write("x", 0))
    await expect(deletePromptOverrideBinding(binding.id, 0)).rejects.toBeInstanceOf(
      PromptOverrideConflictError
    )
    await deletePromptOverrideBinding(binding.id, binding.rev)
    expect(await listPromptOverrideBindings()).toEqual([])
    expect(await getDb().promptOverrideRevisions.count()).toBe(0)
  })
})

describe("onPromptOverridesChanged", () => {
  it("fires after a committed mutation and not after a refused one", async () => {
    const listener = jest.fn()
    const off = onPromptOverridesChanged(listener)
    try {
      await publishPromptOverride(write("x", 0))
      expect(listener).toHaveBeenCalledTimes(1)
      await publishPromptOverride(write("y", 0)).catch(() => undefined)
      expect(listener).toHaveBeenCalledTimes(1)
    } finally {
      off()
    }
  })
})
