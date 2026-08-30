import { assessProjectSalience, PROJECT_SALIENCE_MIN_SIGNALS } from "./project-salience"
import { assessSalience } from "./salience"

const user = (text: string) => ({ role: "user", text })
const assistant = (text: string) => ({ role: "assistant", text })
const toolPart = (toolName: string) => ({
  role: "assistant",
  text: "ran it",
  parts: [{ type: `tool-${toolName}`, toolName }],
})

describe("assessProjectSalience", () => {
  it("fires on a real coding window that the personal gate scores at zero", () => {
    // This is the whole reason the gate exists: `salience.ts` is a first-person
    // detector, so project facts have never been able to reach the extractor.
    const messages = [
      user("why does lib/db/schema.ts need a new version for this?"),
      assistant("Because Dexie requires a version bump; pnpm build must stay green."),
    ]
    expect(assessProjectSalience({ messages }).salient).toBe(true)
    expect(
      assessSalience({ userText: messages[0]!.text, assistantText: messages[1]!.text }).salient
    ).toBe(false)
  })

  it("requires more than one distinct signal", () => {
    // Personal salience needs one signal; a false positive here is multiplied by
    // every window in a project's history, so the bar is higher.
    const oneSignal = assessProjectSalience({ messages: [user("we use pnpm")] })
    expect(oneSignal.signals).toEqual(["tooling-version"])
    expect(oneSignal.salient).toBe(false)
    expect(PROJECT_SALIENCE_MIN_SIGNALS).toBe(2)
  })

  it("counts a local tool result as a structural signal", () => {
    const result = assessProjectSalience({
      messages: [user("does the build pass?"), toolPart("bash")],
    })
    expect(result.signals).toContain("local-tool")
  })

  it("does not count an untrusted tool as a local-tool signal", () => {
    const result = assessProjectSalience({
      messages: [user("search the web"), { ...toolPart("web_search"), text: "results" }],
    })
    expect(result.signals).not.toContain("local-tool")
  })

  it.each([
    ["a file path", "edit components/chat/message-renderer.tsx", "code-reference"],
    ["a repo subtree", "look in packages/memory/ for it", "code-reference"],
    ["an English constraint", "this must never import from app/api", "constraint-or-decision"],
    ["a Chinese constraint", "这里必须走静态导出，不能用服务端路由", "constraint-or-decision"],
    ["an English outcome", "the suite passed after the fix", "outcome-or-gotcha"],
    ["a Chinese outcome", "报错的根因是缓存没失效", "outcome-or-gotcha"],
    ["tooling", "we pinned rust to 1.77.2", "tooling-version"],
  ])("detects %s", (_label, text, expected) => {
    expect(assessProjectSalience({ messages: [user(text)] }).signals).toContain(expected)
  })

  it.each([
    ["an English refusal", "I can't help with that."],
    ["an English clarifying question", "Could you clarify which file you mean?"],
    ["a Chinese refusal", "抱歉，我不能这样做。"],
  ])("scores zero when the only assistant content is %s", (_label, reply) => {
    // Keyword-rich but substanceless: the user's question alone can trip two
    // lexical signals while the window contains no project fact at all.
    const result = assessProjectSalience({
      messages: [user("must we change lib/db/schema.ts for pnpm?"), assistant(reply)],
    })
    expect(result.salient).toBe(false)
    expect(result.signals).toEqual([])
  })

  it("still scores a user-only window with no assistant turn", () => {
    const result = assessProjectSalience({
      messages: [user("we must pin rust to 1.77.2 in crates/cognia-git/Cargo.toml")],
    })
    expect(result.salient).toBe(true)
  })

  it("returns not-salient for an empty window", () => {
    expect(assessProjectSalience({ messages: [] })).toEqual({ salient: false, signals: [] })
  })

  it("ignores small talk entirely", () => {
    expect(
      assessProjectSalience({ messages: [user("thanks!"), assistant("You're welcome.")] })
    ).toMatchObject({ salient: false })
  })
})
