/** @jest-environment jsdom */

import { BRIEF_MODE_PROMPT } from "@/lib/agent/prompts/brief-mode"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getPromptDefinition, listPromptDefinitions } from "../catalog"
import { __resetPluginPromptsForTesting, registerPluginPrompts } from "../plugin-prompts"
import { resourceKey } from "../resources"
import { publishPromptBody } from "../service"
import { invalidatePromptOverrideSnapshot } from "../snapshot"
import { appSettingPromptAdapter } from "./app-settings"
import {
  listCodePromptResources,
  listPromptResources,
  OWNER_PROMPT_ADAPTERS,
  ownerAdapterFor,
} from "./index"
import { presetPromptAdapter } from "./presets"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  invalidatePromptOverrideSnapshot()
})
afterAll(dbFixture.dispose)
afterEach(() => jest.restoreAllMocks())

describe("ownerAdapterFor", () => {
  it("routes a key to the adapter of its source", () => {
    expect(ownerAdapterFor(resourceKey("preset", "p"))).toBe(presetPromptAdapter)
    expect(ownerAdapterFor(resourceKey("code", "chat.brief-mode"))).toBeUndefined()
    expect(ownerAdapterFor("nonsense")).toBeUndefined()
  })

  it("registers one adapter per owner source", () => {
    const sources = OWNER_PROMPT_ADAPTERS.map((adapter) => adapter.source)
    expect(new Set(sources).size).toBe(sources.length)
  })
})

describe("listCodePromptResources", () => {
  it("lists every catalog definition and marks overridden ones modified", async () => {
    await publishPromptBody({
      def: BRIEF_MODE_PROMPT,
      target: { scope: "account", targetId: "" },
      body: "Short.",
      expectedRev: 0,
    })
    const listed = await listCodePromptResources()
    expect(listed).toHaveLength(listPromptDefinitions().length)
    const brief = listed.find((entry) => entry.promptId === BRIEF_MODE_PROMPT.id)
    expect(brief).toMatchObject({
      key: resourceKey("code", BRIEF_MODE_PROMPT.id),
      source: "code",
      group: BRIEF_MODE_PROMPT.group,
      builtIn: true,
      modified: true,
      edit: "publish",
    })
    expect(listed.filter((entry) => entry.modified)).toHaveLength(1)
    for (const entry of listed) {
      expect(entry.edit).toBe(entry.operation === "inspect-only" ? "owner-only" : "publish")
    }
  })
})

describe("plugin slots in listCodePromptResources", () => {
  afterEach(() => __resetPluginPromptsForTesting())

  it("lists an enabled plugin's slot and keeps its overrides listed once it is gone", async () => {
    const dispose = registerPluginPrompts(
      "deep-research",
      [{ id: "outline", title: "Outline", defaultBody: "Plan the report.", group: "knowledge" }],
      "plugins/deep-research/src/engine/prompts.ts"
    )
    const slot = "plugin:deep-research/outline"
    expect(await listCodePromptResources()).toContainEqual(
      expect.objectContaining({ promptId: slot, group: "knowledge", edit: "publish" })
    )
    await publishPromptBody({
      def: getPromptDefinition(slot)!,
      target: { scope: "account", targetId: "" },
      body: "Plan a short report.",
      expectedRev: 0,
    })
    dispose()

    const listed = await listCodePromptResources()
    expect(listed.filter((entry) => entry.promptId === slot)).toEqual([
      {
        key: resourceKey("code", slot),
        source: "code",
        kind: "feature-template",
        operation: "replace-template",
        promptId: slot,
        builtIn: false,
        modified: true,
        edit: "owner-only",
        unavailable: true,
      },
    ])
    expect(listed.filter((entry) => entry.unavailable)).toHaveLength(1)
  })
})

describe("listPromptResources", () => {
  it("merges code slots and owner resources", async () => {
    const { resources, failed } = await listPromptResources({})
    expect(failed).toEqual([])
    expect(resources.some((entry) => entry.source === "code")).toBe(true)
    expect(resources.some((entry) => entry.source === "app-setting")).toBe(true)
  })

  it("reports a failing owner without hiding the others", async () => {
    jest.spyOn(appSettingPromptAdapter, "list").mockRejectedValue(new Error("boom"))
    const { resources, failed } = await listPromptResources({})
    expect(failed).toEqual(["app-setting"])
    expect(resources.some((entry) => entry.source === "app-setting")).toBe(false)
    expect(resources.some((entry) => entry.source === "code")).toBe(true)
  })
})
