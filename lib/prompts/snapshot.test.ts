/** @jest-environment jsdom */

import { publishPromptOverride, resetPromptOverride } from "@/lib/db/prompt-overrides"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  buildPromptOverrideSnapshot,
  invalidatePromptOverrideSnapshot,
  loadPromptOverrideSnapshot,
  peekPromptOverrideSnapshot,
  subscribePromptOverrideSnapshot,
} from "./snapshot"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)

const account = { scope: "account" as const, targetId: "" }
let n = 0
const publish = (body: string, expectedRev: number) =>
  publishPromptOverride({
    promptId: "generation.title.chat",
    target: account,
    body,
    contractVersion: 1,
    baseDigest: "sha256:x",
    expectedRev,
    mutationId: `m${++n}`,
    origin: "editor",
  })

it("groups rows by prompt id", () => {
  const snapshot = buildPromptOverrideSnapshot("db", [
    {
      bindingId: "b1",
      promptId: "p",
      scope: "account",
      targetId: "",
      revisionId: "r1",
      body: "x",
      contractVersion: 1,
    },
  ])
  expect(snapshot.byPrompt.get("p")).toHaveLength(1)
})

it("loads only published active revisions for the active database", async () => {
  expect(peekPromptOverrideSnapshot()).toBeNull()
  const binding = await publish("Live body", 0)
  const snapshot = await loadPromptOverrideSnapshot()
  expect(snapshot.databaseName).toBe(getDb().name)
  expect(snapshot.byPrompt.get("generation.title.chat")?.[0]).toMatchObject({
    body: "Live body",
    revisionId: binding.activeRevisionId,
  })
  expect(peekPromptOverrideSnapshot()).toBe(snapshot)
})

it("reloads after a committed mutation and drops a reset binding", async () => {
  const binding = await publish("Live body", 0)
  await loadPromptOverrideSnapshot()
  const replaced = new Promise<void>((resolve) => {
    const off = subscribePromptOverrideSnapshot(() => {
      off()
      resolve()
    })
  })
  await resetPromptOverride({
    promptId: "generation.title.chat",
    target: account,
    expectedRev: binding.rev,
    mutationId: "reset-1",
    origin: "editor",
    contractVersion: 1,
    baseDigest: "sha256:x",
  })
  await replaced
  expect(peekPromptOverrideSnapshot()?.byPrompt.get("generation.title.chat")).toBeUndefined()
})
