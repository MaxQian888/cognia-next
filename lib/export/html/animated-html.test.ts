/** @jest-environment jsdom */
import { exportToAnimatedHtml } from "./animated-html"
import type { ChatSession, StoredMessage } from "@/lib/claude/types"

const session: ChatSession = {
  id: "s1",
  title: "Test Session",
  kind: "direct",
  createdAt: 0,
  updatedAt: 0,
} as unknown as ChatSession

const messages: StoredMessage[] = [
  {
    id: "m1",
    sessionId: "s1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
    createdAt: 1,
  } as unknown as StoredMessage,
  {
    id: "m2",
    sessionId: "s1",
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
    createdAt: 2,
  } as unknown as StoredMessage,
]

describe("exportToAnimatedHtml", () => {
  it("injects animation script + stylesheet into the body", () => {
    const html = exportToAnimatedHtml({
      session,
      messages,
      exportedAt: new Date("2024-06-01T00:00:00Z"),
    })
    expect(html).toContain("<style>")
    expect(html).toContain(".text-typing::after")
    expect(html).toContain("requestAnimationFrame(play)")
    expect(html).toContain("</body>")
    // The script lives just before </body>
    expect(html.indexOf("requestAnimationFrame(play)")).toBeLessThan(html.indexOf("</body>"))
  })

  it("uses the default typing speed when none is given", () => {
    const html = exportToAnimatedHtml({
      session,
      messages,
      exportedAt: new Date(),
    })
    expect(html).toContain("setTimeout(r, 12)")
  })

  it("honors a custom typing speed", () => {
    const html = exportToAnimatedHtml({
      session,
      messages,
      exportedAt: new Date(),
      typingSpeedMs: 30,
    })
    expect(html).toContain("setTimeout(r, 30)")
    expect(html).not.toContain("setTimeout(r, 12)")
  })
})
