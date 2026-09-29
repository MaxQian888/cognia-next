import type { ChatSession } from "@cognia/agent-config-types"
import { continueAsProjectRefusal } from "./continue-eligibility"

function session(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    kind: "direct",
    title: "Refactor billing",
    projectId: "p1",
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as ChatSession
}

describe("continueAsProjectRefusal", () => {
  it("only accepts an idle, unlinked direct conversation in a workspace", () => {
    expect(continueAsProjectRefusal(undefined)).toBe("missing")
    expect(continueAsProjectRefusal(session({ projectId: undefined }))).toBe("no-workspace")
    expect(continueAsProjectRefusal(session({ projectRole: "thread" }))).toBe("already-project")
    expect(continueAsProjectRefusal(session({ parentSessionId: "x" }))).toBe("linked")
    expect(continueAsProjectRefusal(session({ kind: "team" } as Partial<ChatSession>))).toBe(
      "linked"
    )
    expect(continueAsProjectRefusal(session(), "streaming")).toBe("busy")
    expect(continueAsProjectRefusal(session())).toBeNull()
  })
})
