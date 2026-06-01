import { assessSalience } from "./salience"

describe("assessSalience", () => {
  it("flags explicit capture (remember / 记住)", () => {
    expect(assessSalience({ userText: "remember that I use pnpm" }).explicitCapture).toBe(true)
    expect(assessSalience({ userText: "记住：我用 pnpm" }).explicitCapture).toBe(true)
    expect(assessSalience({ userText: "Please remember my name is Max" }).explicitCapture).toBe(
      true
    )
  })

  it("flags English first-person self-facts", () => {
    expect(assessSalience({ userText: "I use pnpm for everything" }).salient).toBe(true)
    expect(assessSalience({ userText: "I'm a backend engineer" }).reasons).toContain("self-fact")
    expect(assessSalience({ userText: "I live in Shanghai" }).salient).toBe(true)
  })

  it("flags possessive preferences", () => {
    expect(assessSalience({ userText: "my stack is Next.js and Rust" }).reasons).toContain(
      "possessive-preference"
    )
    expect(assessSalience({ userText: "my name is Max" }).salient).toBe(true)
  })

  it("flags 中文 first-person signals", () => {
    expect(assessSalience({ userText: "我喜欢用 pnpm" }).salient).toBe(true)
    expect(assessSalience({ userText: "我是后端工程师" }).reasons).toContain("self-fact")
    expect(assessSalience({ userText: "以后都用中文回复" }).reasons).toContain("preference-verb")
  })

  it("flags preference / instruction verbs", () => {
    expect(assessSalience({ userText: "always reply in Chinese" }).reasons).toContain(
      "preference-verb"
    )
    expect(assessSalience({ userText: "never use yarn" }).salient).toBe(true)
  })

  it("flags high named-entity density", () => {
    const s = assessSalience({ userText: "We deploy to Vercel using Next.js and Postgres" })
    expect(s.reasons).toContain("named-entities")
  })

  it("does not flag the sentence-initial capital as a named entity", () => {
    const s = assessSalience({ userText: "Hello there friend" })
    expect(s.reasons).not.toContain("named-entities")
  })

  it("returns not-salient for trivial chatter", () => {
    expect(assessSalience({ userText: "ok thanks" }).salient).toBe(false)
    expect(assessSalience({ userText: "what's the weather?" }).salient).toBe(false)
    expect(assessSalience({ userText: "" }).salient).toBe(false)
  })

  it("handles missing userText defensively", () => {
    expect(assessSalience({ userText: undefined as unknown as string }).salient).toBe(false)
  })
})
