/** @jest-environment jsdom */

import { createChatTemplate } from "@/lib/db/chat-templates"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { resourceKey } from "../resources"
import { composerTemplatePromptAdapter as adapter } from "./composer-templates"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("composerTemplatePromptAdapter", () => {
  it("lists templates as owner-only user messages and reads their body", async () => {
    const template = await createChatTemplate({
      name: "Standup",
      description: "Daily",
      body: "Summarize {{day}}",
    })
    const key = resourceKey("composer-template", template.id)
    expect(await adapter.list({})).toContainEqual({
      key,
      source: "composer-template",
      kind: "composer-template",
      operation: "inspect-only",
      name: "Standup",
      builtIn: false,
      modified: false,
      edit: "owner-only",
      ownerSection: "chatTemplates",
      detail: "Daily",
    })
    expect(await adapter.read(key, {})).toEqual({ key, text: "Summarize {{day}}" })
  })

  it("has no write path and reads foreign or missing keys as absent", async () => {
    expect(adapter.save).toBeUndefined()
    expect(adapter.saveCustom).toBeUndefined()
    expect(await adapter.read("preset:x", {})).toBeUndefined()
    expect(await adapter.read(resourceKey("composer-template", "gone"), {})).toBeUndefined()
  })
})
