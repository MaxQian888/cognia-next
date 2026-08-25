import { bindingFromRun, readChatTemplateRun, templateRunFromBinding } from "./run"
import type { ChatTemplateBinding } from "./binding"

const binding: ChatTemplateBinding = {
  templateId: "tpl_review",
  version: "3",
  insertedAt: 100,
  params: { module: { kind: "text", value: "auth" } },
}

describe("templateRunFromBinding", () => {
  it("keeps the sentence as it read BEFORE substitution", () => {
    expect(templateRunFromBinding(binding, "review {{module}} please")).toEqual({
      templateId: "tpl_review",
      version: "3",
      text: "review {{module}} please",
      params: { module: { kind: "text", value: "auth" } },
    })
  })

  // A re-run button on a turn with nothing to vary reproduces the message it
  // is attached to.
  it("records nothing when there is nothing to vary", () => {
    expect(templateRunFromBinding(undefined, "hello")).toBeNull()
    expect(templateRunFromBinding({ ...binding, params: {} }, "hello")).toBeNull()
  })

  it("copies the values rather than aliasing the live binding", () => {
    const run = templateRunFromBinding(binding, "review {{module}}")!
    binding.params.module = { kind: "text", value: "billing" }
    expect(run.params.module).toEqual({ kind: "text", value: "auth" })
  })
})

describe("readChatTemplateRun", () => {
  const stored = {
    templateRun: {
      templateId: "tpl_review",
      version: "3",
      text: "review {{module}}",
      params: {
        module: { kind: "text", value: "auth" },
        target: {
          kind: "resource",
          resourceKind: "file",
          id: "src/app.ts",
          label: "src/app.ts",
          raw: "@src/app.ts",
        },
      },
    },
  }

  it("reads both value shapes back", () => {
    expect(readChatTemplateRun(stored)).toEqual(stored.templateRun)
  })

  it("has nothing to say about a message that carried no run", () => {
    expect(readChatTemplateRun(undefined)).toBeNull()
    expect(readChatTemplateRun({})).toBeNull()
    expect(readChatTemplateRun({ templateRun: "nope" })).toBeNull()
  })

  // Rows are persisted and synced: an older build or another device can put
  // anything here, and one hidden button beats a crashed transcript.
  it("reads a malformed record as absent", () => {
    expect(readChatTemplateRun({ templateRun: { templateId: 1, version: "3" } })).toBeNull()
    expect(
      readChatTemplateRun({ templateRun: { templateId: "t", version: "3", text: "  " } })
    ).toBeNull()
    expect(
      readChatTemplateRun({ templateRun: { templateId: "t", version: "3", text: "x", params: [] } })
    ).toBeNull()
  })

  it("drops an unreadable value rather than the whole record", () => {
    const run = readChatTemplateRun({
      templateRun: {
        templateId: "t",
        version: "1",
        text: "a {{x}} b {{y}}",
        params: { x: { kind: "text", value: "ok" }, y: { kind: "resource", id: 7 } },
      },
    })
    expect(run?.params).toEqual({ x: { kind: "text", value: "ok" } })
  })

  it("reads nothing when every value was unreadable", () => {
    expect(
      readChatTemplateRun({
        templateRun: { templateId: "t", version: "1", text: "x", params: { y: { kind: "??" } } },
      })
    ).toBeNull()
  })
})

describe("bindingFromRun", () => {
  it("stamps the draft with when it was written, not when the turn ran", () => {
    const run = templateRunFromBinding(binding, "review {{module}}")!
    expect(bindingFromRun(run, 999)).toEqual({
      templateId: "tpl_review",
      version: "3",
      params: run.params,
      insertedAt: 999,
    })
  })
})
