/**
 * Coverage for the shared twin-injection helper (M6). The downstream
 * `applyTwinContext` is exercised by its own tests — here we focus on
 * the helper's contract: lookup → guard → injection → inject-log entry.
 */

import "fake-indexeddb/auto"
import { injectTwinContext } from "./twin-injector"
import { __resetTwinInjectLog, readTwinInjectLog } from "@/lib/twin/runtime/inject-log"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createCharacter } from "@/lib/db/characters"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  __resetTwinInjectLog()
})

describe("injectTwinContext", () => {
  it("returns the base prompt unchanged when characterId is missing", async () => {
    const result = await injectTwinContext({
      userPrompt: "hi",
      baseSystemPrompt: "Be helpful.",
      source: "test",
    })
    expect(result.applied).toBe(false)
    expect(result.systemPrompt).toBe("Be helpful.")
    expect(readTwinInjectLog()).toHaveLength(0)
  })

  it("returns the base prompt when the character has no twinId", async () => {
    const character = await createCharacter({
      name: "Plain",
      systemPrompt: "Be plain.",
    })
    const result = await injectTwinContext({
      characterId: character.id,
      userPrompt: "hi",
      baseSystemPrompt: "Base",
      source: "test",
    })
    expect(result.applied).toBe(false)
    expect(result.systemPrompt).toBe("Base")
    expect(readTwinInjectLog()).toHaveLength(0)
  })

  it("returns the base prompt when the twin runtime is not configured", async () => {
    const character = await createCharacter({
      name: "Twinned",
      systemPrompt: "Original",
      twinId: "twin_a",
    })
    const result = await injectTwinContext({
      characterId: character.id,
      userPrompt: "hi",
      baseSystemPrompt: "Original",
      source: "test:source",
    })
    expect(result.applied).toBe(false)
    expect(result.systemPrompt).toBe("Original")
    // The log captures the degraded attempt so users can see "tried but
    // runtime was unavailable".
    const log = readTwinInjectLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      twinId: "twin_a",
      source: "test:source",
      applied: false,
      degraded: true,
      degradedReason: "twin-deps-unavailable",
    })
  })

  it("never throws — caller-side errors degrade to the base prompt", async () => {
    // Pass a `userPrompt` that's whitespace only — the helper short-circuits.
    const result = await injectTwinContext({
      characterId: "any",
      userPrompt: "   ",
      baseSystemPrompt: "Base",
      source: "test",
    })
    expect(result.applied).toBe(false)
    expect(result.systemPrompt).toBe("Base")
  })
})
