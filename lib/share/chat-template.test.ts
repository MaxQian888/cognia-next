import {
  buildSharedChatTemplate,
  parseSharedChatTemplate,
  redactSharedChatTemplate,
  serializeSharedChatTemplate,
  sharedChatTemplateHasPii,
  type ShareableChatTemplate,
} from "./chat-template"

function template(over: Partial<ShareableChatTemplate> = {}): ShareableChatTemplate {
  return {
    name: "Bug report",
    description: "How we file one",
    body: "Report {{area}} against {{branch}}",
    params: [
      { id: "area", label: "Area", required: true, kind: "string" },
      { id: "branch", label: "Branch", required: false, kind: "string", defaultValue: "dev" },
    ],
    ...over,
  }
}

describe("buildSharedChatTemplate", () => {
  it("keeps the body and the declarations", () => {
    const shared = buildSharedChatTemplate(template())
    expect(shared.kind).toBe("chat-template")
    expect(shared.body).toBe("Report {{area}} against {{branch}}")
    expect(shared.params.map((p) => p.id)).toEqual(["area", "branch"])
    expect(shared.params[1].defaultValue).toBe("dev")
  })

  it("drops a declaration whose id names a credential", () => {
    const shared = buildSharedChatTemplate(
      template({
        body: "Call with {{apiKey}} for {{area}}",
        params: [
          { id: "apiKey", label: "Key", required: true, kind: "string", defaultValue: "sk-live" },
          { id: "area", label: "Area", required: true, kind: "string" },
        ],
      })
    )
    expect(shared.params.map((p) => p.id)).toEqual(["area"])
    expect(serializeSharedChatTemplate(shared)).not.toContain("sk-live")
  })

  it("demotes the launch spec: capability grants never travel", () => {
    const shared = buildSharedChatTemplate(
      template({
        launchSpec: {
          model: "sonnet",
          permissionMode: "bypassPermissions",
          allowedTools: ["Bash"],
          mcpServerIds: ["srv"],
          skillIds: ["s1"],
          agentModeId: "mode",
          workingDir: "/Users/someone/secret",
          disallowedTools: ["WebFetch"],
        },
      })
    )
    expect(shared.launchSpec).toEqual({
      model: "sonnet",
      disallowedTools: ["WebFetch"],
    })
  })

  it("omits the launch spec entirely when nothing survives demotion", () => {
    const shared = buildSharedChatTemplate(
      template({ launchSpec: { allowedTools: ["Bash"], workingDir: "/tmp" } })
    )
    expect(shared.launchSpec).toBeUndefined()
  })
})

describe("parseSharedChatTemplate", () => {
  it("round-trips a built body", () => {
    const shared = buildSharedChatTemplate(template())
    expect(parseSharedChatTemplate(serializeSharedChatTemplate(shared))).toEqual(shared)
  })

  it("re-demotes on the way in, so a hand-crafted payload cannot smuggle a grant", () => {
    const forged = JSON.stringify({
      kind: "chat-template",
      name: "Nice",
      body: "hi",
      params: [],
      launchSpec: { permissionMode: "bypassPermissions", allowedTools: ["Bash"], model: "opus" },
    })
    expect(parseSharedChatTemplate(forged)?.launchSpec).toEqual({ model: "opus" })
  })

  it("returns null for junk and for the wrong kind", () => {
    expect(parseSharedChatTemplate("{")).toBeNull()
    expect(parseSharedChatTemplate(JSON.stringify({ kind: "discover-item" }))).toBeNull()
  })
})

describe("PII gate", () => {
  it("flags an email and can redact it away", () => {
    const shared = buildSharedChatTemplate(template({ body: "mail alice@example.com" }))
    expect(sharedChatTemplateHasPii(shared)).toBe(true)
    const redacted = redactSharedChatTemplate(shared)
    expect(redacted.body).not.toContain("alice@example.com")
    expect(sharedChatTemplateHasPii(redacted)).toBe(false)
  })

  it("passes a clean template", () => {
    expect(sharedChatTemplateHasPii(buildSharedChatTemplate(template()))).toBe(false)
  })
})
