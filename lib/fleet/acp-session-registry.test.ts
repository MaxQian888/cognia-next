import {
  __resetAcpSessionRegistryForTests,
  acpSessionOwnerFacts,
  registerAcpSession,
  unregisterAcpSession,
} from "./acp-session-registry"

describe("acp-session-registry", () => {
  beforeEach(() => __resetAcpSessionRegistryForTests())

  it("returns undefined for unknown or empty session ids", () => {
    expect(acpSessionOwnerFacts("missing")).toBeUndefined()
    expect(acpSessionOwnerFacts("")).toBeUndefined()
    expect(acpSessionOwnerFacts(null)).toBeUndefined()
    expect(acpSessionOwnerFacts(undefined)).toBeUndefined()
  })

  it("registers and reads facts", () => {
    registerAcpSession("s1", { agent: "devin", agentId: "agent-1", agentLabel: "Devin" })
    expect(acpSessionOwnerFacts("s1")).toEqual({
      agent: "devin",
      agentId: "agent-1",
      agentLabel: "Devin",
    })
  })

  it("merges updates instead of dropping fields the update did not carry", () => {
    registerAcpSession("s1", { agent: "devin", agentId: "agent-1" })
    registerAcpSession("s1", {
      agent: "devin",
      agentId: "agent-1",
      chatSessionId: "chat-9",
    })
    expect(acpSessionOwnerFacts("s1")).toEqual({
      agent: "devin",
      agentId: "agent-1",
      chatSessionId: "chat-9",
    })
  })

  it("unregisters a session", () => {
    registerAcpSession("s1", { agent: "acp", agentId: "agent-1" })
    unregisterAcpSession("s1")
    expect(acpSessionOwnerFacts("s1")).toBeUndefined()
  })

  it("reset clears everything", () => {
    registerAcpSession("s1", { agent: "devin", agentId: "a" })
    registerAcpSession("s2", { agent: "acp", agentId: "b" })
    __resetAcpSessionRegistryForTests()
    expect(acpSessionOwnerFacts("s1")).toBeUndefined()
    expect(acpSessionOwnerFacts("s2")).toBeUndefined()
  })
})
