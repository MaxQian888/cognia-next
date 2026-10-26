/** @jest-environment jsdom */

import { applyPromptOverrideBackup } from "./prompt-overrides-backup"
import type { ImportSummary } from "./types"
import type { PromptOverrideBindingRow, PromptOverrideRevisionRow } from "@/lib/db/prompt-overrides"
import { getPromptOverrideBinding, listPromptOverrideRevisions } from "@/lib/db/prompt-overrides"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const summary = (): ImportSummary => ({
  added: {},
  overwritten: {},
  skipped: {},
  builtInsSkipped: {},
})

function unit(
  bindingId: string,
  body: string,
  revisionId = `${bindingId}-r`
): { binding: PromptOverrideBindingRow; revision: PromptOverrideRevisionRow } {
  return {
    binding: {
      id: bindingId,
      promptId: "generation.title.chat",
      scope: "account",
      targetId: "",
      activeRevisionId: revisionId,
      draftRevisionId: null,
      rev: 3,
      createdAt: 1,
      updatedAt: 2,
    },
    revision: {
      id: revisionId,
      bindingId,
      promptId: "generation.title.chat",
      parentId: null,
      kind: "published",
      body,
      contractVersion: 1,
      baseDigest: "sha256:base",
      origin: "editor",
      mutationId: "m",
      createdAt: 2,
    },
  }
}

it("adds a binding and its revisions when the slot is free", async () => {
  const { binding, revision } = unit("pob_a", "Imported")
  const s = summary()
  await applyPromptOverrideBackup({
    db: getDb(),
    bindings: [binding],
    revisions: [revision],
    opts: { mergeStrategy: "skip" },
    summary: s,
  })
  expect(s.added.promptOverrides).toBe(1)
  const restored = await getPromptOverrideBinding("generation.title.chat", {
    scope: "account",
    targetId: "",
  })
  expect(restored?.activeRevisionId).toBe(revision.id)
  expect((await listPromptOverrideRevisions(restored!.id))[0].body).toBe("Imported")
})

it("keeps the local binding on skip and replaces it as a unit on overwrite", async () => {
  const local = unit("pob_local", "Mine")
  await getDb().promptOverrides.put(local.binding)
  await getDb().promptOverrideRevisions.put(local.revision)
  const incoming = unit("pob_in", "Theirs")

  const skipped = summary()
  await applyPromptOverrideBackup({
    db: getDb(),
    bindings: [incoming.binding],
    revisions: [incoming.revision],
    opts: { mergeStrategy: "skip" },
    summary: skipped,
  })
  expect(skipped.skipped.promptOverrides).toBe(1)
  expect(await getDb().promptOverrides.get("pob_local")).toBeDefined()

  const overwritten = summary()
  await applyPromptOverrideBackup({
    db: getDb(),
    bindings: [incoming.binding],
    revisions: [incoming.revision],
    opts: { mergeStrategy: "duplicate" },
    summary: overwritten,
  })
  // Two bindings for one slot cannot coexist, so duplicate collapses to overwrite.
  expect(overwritten.overwritten.promptOverrides).toBe(1)
  expect(await getDb().promptOverrides.get("pob_local")).toBeUndefined()
  expect(await getDb().promptOverrideRevisions.get(local.revision.id)).toBeUndefined()
  expect((await getDb().promptOverrideRevisions.get(incoming.revision.id))?.body).toBe("Theirs")
})

it("re-mints colliding revision ids and never leaves a dangling pointer", async () => {
  // An unrelated local revision already owns the imported revision's id.
  const other = unit("pob_other", "Other", "shared-id")
  await getDb().promptOverrides.put({ ...other.binding, promptId: "goal.judge.system" })
  await getDb().promptOverrideRevisions.put({ ...other.revision, promptId: "goal.judge.system" })

  const incoming = unit("pob_in", "Theirs", "shared-id")
  const orphanDraft = { ...incoming.binding, draftRevisionId: "not-in-package" }
  await applyPromptOverrideBackup({
    db: getDb(),
    bindings: [orphanDraft],
    revisions: [incoming.revision],
    opts: { mergeStrategy: "overwrite" },
    summary: summary(),
  })
  const restored = await getDb().promptOverrides.get("pob_in")
  expect(restored?.activeRevisionId).not.toBe("shared-id")
  expect((await getDb().promptOverrideRevisions.get(restored!.activeRevisionId!))?.body).toBe(
    "Theirs"
  )
  expect(restored?.draftRevisionId).toBeNull()
  expect((await getDb().promptOverrideRevisions.get("shared-id"))?.body).toBe("Other")
})
