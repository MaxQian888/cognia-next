import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import { buildSharedChatTemplate, serializeSharedChatTemplate } from "@/lib/share/chat-template"
import {
  adoptSharedChatTemplatePayload,
  installSharedChatTemplate,
} from "./install-shared-template"

function fakeCreate() {
  const calls: Array<Record<string, unknown>> = []
  const create = (async (draft: Record<string, unknown>) => {
    calls.push(draft)
    return { id: "tpl_new", revision: 1, ...draft } as unknown as ChatTemplateRow
  }) as never
  return { create, calls }
}

describe("installSharedChatTemplate", () => {
  it("writes a new row and never reuses the sender's id", async () => {
    const { create, calls } = fakeCreate()
    const shared = buildSharedChatTemplate({
      name: "Bug report",
      description: "How we file one",
      body: "Report {{area}}",
      params: [{ id: "area", label: "Area", required: true, kind: "string" }],
    })
    const row = await installSharedChatTemplate(shared, { create })
    expect(row.id).toBe("tpl_new")
    expect(calls[0]).toEqual({
      name: "Bug report",
      description: "How we file one",
      body: "Report {{area}}",
      params: shared.params,
    })
    expect(calls[0]).not.toHaveProperty("id")
  })

  it("omits an absent launch spec instead of writing undefined", async () => {
    const { create, calls } = fakeCreate()
    await installSharedChatTemplate(buildSharedChatTemplate({ name: "N", body: "b", params: [] }), {
      create,
    })
    expect(calls[0]).not.toHaveProperty("launchSpec")
    expect(calls[0]).not.toHaveProperty("description")
  })
})

describe("adoptSharedChatTemplatePayload", () => {
  it("parses and adopts, re-demoting the launch spec on the way in", async () => {
    const { create, calls } = fakeCreate()
    const body = JSON.stringify({
      kind: "chat-template",
      name: "Nice",
      body: "hi",
      params: [],
      launchSpec: { permissionMode: "bypassPermissions", model: "opus", allowedTools: ["Bash"] },
    })
    await adoptSharedChatTemplatePayload(body, { create })
    expect(calls[0].launchSpec).toEqual({ model: "opus" })
  })

  it("round-trips a serialized share", async () => {
    const { create, calls } = fakeCreate()
    const shared = buildSharedChatTemplate({ name: "N", body: "{{a}}", params: [] })
    await adoptSharedChatTemplatePayload(serializeSharedChatTemplate(shared), { create })
    expect(calls[0].body).toBe("{{a}}")
  })

  it("throws on a payload it cannot read", async () => {
    const { create } = fakeCreate()
    await expect(adoptSharedChatTemplatePayload("{", { create })).rejects.toThrow(
      /could not be read/
    )
  })
})
