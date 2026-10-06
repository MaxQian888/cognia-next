import {
  clearKnowledgeReaderForSession,
  getKnowledgeReaderForSession,
  registerKnowledgeReaderForSession,
  registerKnowledgeAccessForSession,
  getKnowledgeAccessForSession,
} from "./session-reader"

afterEach(() => clearKnowledgeReaderForSession("session"))
it("fails closed for unregistered sessions and clears stale authority", () => {
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
  registerKnowledgeReaderForSession("session", {
    knowledgeBaseIds: ["kb"],
    settings: { enabled: true },
  })
  expect(getKnowledgeReaderForSession("session")?.settings.enabled).toBe(true)
  clearKnowledgeReaderForSession("session")
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
})
it("expires inactive registrations and rejects empty sessions", () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(0)
  registerKnowledgeReaderForSession("session", { knowledgeBaseIds: [] })
  now.mockReturnValue(3_600_001)
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
  expect(() => registerKnowledgeReaderForSession("", { knowledgeBaseIds: [] })).toThrow(
    "session_required"
  )
  now.mockRestore()
})

it("captures execution authority even when progressive tools are disabled and copies nested ceilings", () => {
  const knowledgeAccess = {
    entrypoint: "http" as const,
    revisionBindings: { kb: ["gen"] },
    allowedKnowledgeBaseIds: ["kb"],
  }
  registerKnowledgeAccessForSession("session", { knowledgeBaseIds: ["kb"], knowledgeAccess })
  knowledgeAccess.allowedKnowledgeBaseIds.push("other")
  const captured = getKnowledgeAccessForSession("session")!
  expect(captured.knowledgeAccess.allowedKnowledgeBaseIds).toEqual(["kb"])
  expect(getKnowledgeReaderForSession("session")).toBeUndefined()
  captured.knowledgeAccess.allowedKnowledgeBaseIds = []
  expect(getKnowledgeAccessForSession("session")!.knowledgeAccess.allowedKnowledgeBaseIds).toEqual([
    "kb",
  ])
})
