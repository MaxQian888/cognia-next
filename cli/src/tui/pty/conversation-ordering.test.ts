/**
 * What the reader sees, in the order it happened.
 *
 * Two things used to move on screen. A status notice was appended to the
 * committed transcript, which is painted ABOVE the live region, so a line about
 * the turn in progress surfaced above the tool cards and the reply that were
 * already visible. And the live region painted reasoning above tool cards while
 * the reducer committed them the other way round, so every finished card jumped
 * over the reasoning at the end of the turn.
 *
 * Both are screen-order bugs, so both are asserted against the screen.
 */
import { runConversation } from "./conversation-driver"

jest.setTimeout(120_000)

describe("transcript ordering", () => {
  it("keeps a mid-turn notice under the tool cards it arrived after", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "tool-call", id: "t1", toolName: "read", input: { path: "a.ts" } },
                { kind: "tool-result", id: "t1", toolName: "read", result: "ok" },
                { kind: "notice" },
                { kind: "hold" },
              ],
              reply: "done",
            },
          ],
        },
        rows: 30,
        cols: 100,
      },
      async (session) => {
        await session.send("read a file")
        await session.waitForText("Context compacted")
        const lines = session.rows()
        const card = lines.findIndex((l) => l.includes("read"))
        const notice = lines.findIndex((l) => l.includes("Context compacted"))
        expect(card).toBeGreaterThanOrEqual(0)
        expect(notice).toBeGreaterThan(card)
        session.press("escape")
        await session.waitForText("Turn stopped by user")
      }
    )
    // And it stays there once the turn commits: the committed transcript reads
    // the same as the screen it replaced.
    const lines = result.finalScreen.split("\n")
    const card = lines.findIndex((l) => l.includes("read"))
    const notice = lines.findIndex((l) => l.includes("Context compacted"))
    expect(notice).toBeGreaterThan(card)
  })

  it("does not move a tool card past the reasoning when the turn commits", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "tool-call", id: "t1", toolName: "read", input: { path: "a.ts" } },
                { kind: "tool-result", id: "t1", toolName: "read", result: "ok" },
                { kind: "thinking", delta: "weighing the options" },
                // Long enough for the live frame to be read while the turn
                // is genuinely still open. It only bounds the failure: the
                // assertions below wait for what they assert.
                { kind: "delay", ms: 10_000 },
                { kind: "text", delta: "the file is fine" },
              ],
            },
          ],
        },
        rows: 30,
        cols: 100,
      },
      async (session) => {
        await session.send("read then think")
        await session.waitForText("Thinking")
        const live = session.rows()
        const liveCard = live.findIndex((l) => l.includes("read"))
        const liveThinking = live.findIndex((l) => l.includes("Thinking"))
        expect(liveThinking).toBeGreaterThan(liveCard)
        await session.waitForTurnEnd(1)
        await session.waitForText("the file is fine")
        // Reasoning collapses to a row of its own once committed, and it has to
        // stay below the card it was below a moment ago.
        const after = session.rows()
        const card = after.findIndex((l) => l.includes("read"))
        const reply = after.findIndex((l) => l.includes("the file is fine"))
        expect(card).toBeGreaterThanOrEqual(0)
        expect(reply).toBeGreaterThan(card)
      }
    )
  })
})
