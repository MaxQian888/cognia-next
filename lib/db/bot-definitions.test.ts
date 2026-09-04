/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import {
  BotDefinitionError,
  assertBotDefinitionShape,
  createBotDefinition,
  deleteBotDefinition,
  getBotDefinition,
  listBotDefinitions,
  updateBotDefinition,
} from "./bot-definitions"
import { installBot } from "./bot-installations"
import { __resetDbForTesting, getDb } from "./schema"

const NOW = 1_700_000_000_000

const manual = [{ id: "run", kind: "manual" as const }]

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "Triage",
    executor: "workflow" as const,
    workflow: "wf_triage",
    triggers: manual,
    now: NOW,
    ...overrides,
  }
}

describe("assertBotDefinitionShape", () => {
  it("requires the executor's own target", () => {
    expect(() => assertBotDefinitionShape({ executor: "squad", triggers: manual })).toThrow(
      BotDefinitionError
    )
  })

  it("refuses a target belonging to another executor", () => {
    expect(() =>
      assertBotDefinitionShape({
        executor: "workflow",
        workflow: "wf_1",
        team: "team_1",
        triggers: manual,
      })
    ).toThrow(/must not declare "team"/)
  })

  it("refuses a definition with no trigger", () => {
    expect(() =>
      assertBotDefinitionShape({ executor: "workflow", workflow: "wf_1", triggers: [] })
    ).toThrow(/at least one trigger/)
  })
})

describe("botDefinitions", () => {
  beforeEach(async () => {
    __resetDbForTesting()
    await getDb().botDefinitions.clear()
    await getDb().botInstallations.clear()
  }, 15_000)

  it("creates a definition with a generated id and a starting version", async () => {
    const row = await createBotDefinition(input())

    expect(row.id).toMatch(/^bot_/)
    expect(row.version).toBe("0.1.0")
    expect(row.createdAt).toBe(NOW)
    expect(await getBotDefinition(row.id)).toEqual(row)
  })

  it("omits absent optional fields rather than storing undefined", async () => {
    const row = await createBotDefinition(input())
    expect("team" in row).toBe(false)
    expect("description" in row).toBe(false)
  })

  it("refuses to create a definition that names two targets", async () => {
    await expect(createBotDefinition(input({ team: "team_1" }))).rejects.toThrow(
      /must not declare "team"/
    )
    expect(await listBotDefinitions()).toEqual([])
  })

  it("validates a patch against the merged row, not the patch", async () => {
    const row = await createBotDefinition(input())

    // Switching the executor without supplying the new target must fail, even
    // though the patch on its own carries nothing invalid.
    await expect(updateBotDefinition(row.id, { executor: "squad" })).rejects.toThrow(
      /requires a "team"/
    )
  })

  it("clears the previous target when the executor changes", async () => {
    const row = await createBotDefinition(input())
    const updated = await updateBotDefinition(row.id, {
      executor: "squad",
      team: "team_1",
      now: NOW + 1,
    })

    expect(updated?.executor).toBe("squad")
    expect(updated?.team).toBe("team_1")
    // Leaving `workflow` behind would make the row mean two things.
    expect("workflow" in (updated ?? {})).toBe(false)
    expect(updated?.updatedAt).toBe(NOW + 1)
  })

  it("returns undefined when patching a definition that is not there", async () => {
    expect(await updateBotDefinition("bot_missing", { name: "x" })).toBeUndefined()
  })

  it("lists a workspace's own definitions plus the account-wide ones", async () => {
    await createBotDefinition(input({ name: "account-wide", now: NOW }))
    await createBotDefinition(input({ name: "mine", workspaceId: "ws_1", now: NOW + 1 }))
    await createBotDefinition(input({ name: "theirs", workspaceId: "ws_2", now: NOW + 2 }))

    const names = (await listBotDefinitions({ workspaceId: "ws_1" })).map((d) => d.name)
    expect(names).toEqual(["mine", "account-wide"])
  })

  it("refuses to delete a definition installations still point at", async () => {
    const row = await createBotDefinition(input())
    await installBot({
      definitionId: row.id,
      definitionSource: "local",
      pinnedVersion: row.version,
      scope: { kind: "account" },
      now: NOW,
    })

    // Cascading here would silently disarm a Bot somebody relies on.
    await expect(deleteBotDefinition(row.id)).rejects.toThrow(/1 installation still uses/)
    expect(await getBotDefinition(row.id)).toBeDefined()
  })

  it("deletes a definition nothing installs", async () => {
    const row = await createBotDefinition(input())
    await deleteBotDefinition(row.id)
    expect(await getBotDefinition(row.id)).toBeUndefined()
  })
})
