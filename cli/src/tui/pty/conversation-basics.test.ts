/** @jest-environment node */
/**
 * Batch A: startup, a first question, a streamed reply, a follow-up, and exit.
 *
 * Every assertion is against the reconstructed SCREEN, so what is checked is
 * what the user is looking at rather than every byte the app ever wrote.
 */
import { nodePtyAvailable } from "./node-pty-harness"
import { runConversation } from "./conversation-driver"

const maybe = nodePtyAvailable() ? describe : describe.skip

maybe("conversation: startup and basic exchange", () => {
  jest.setTimeout(90_000)

  it("opens with the composer ready and no transcript", async () => {
    await runConversation({ scenario: {} }, async (session) => {
      await session.waitForText("Ask, run /commands")
      // The banner names the model and the working directory. A session that
      // opens without saying which agent it is about to spend money on is the
      // first thing a user has to guess at.
      await session.waitForText("Cognia Agent")
    })
  })

  it("streams a reply, in chunks, into the transcript", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "text", delta: "first part " },
                { kind: "text", delta: "and second part" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("ping")
        // The prompt stays on screen above its answer.
        await session.waitForText("ping")
        await session.waitForText("first part and second part")
      }
    )
    expect(result.record.prompts).toEqual(["ping"])
  })

  it("keeps the first exchange on screen while the second one answers", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            { steps: [{ kind: "text", delta: "answer one" }] },
            { steps: [{ kind: "text", delta: "answer two" }] },
          ],
        },
      },
      async (session) => {
        await session.send("q one")
        await session.waitForText("answer one")
        await session.send("q two")
        await session.waitForText("answer two")
        // Both turns, in order. A follow-up that scrolls its own question away
        // leaves the answer with nothing to attach to.
        const screen = session.flat()
        expect(screen.indexOf("answer one")).toBeLessThan(screen.indexOf("q two"))
        expect(screen.indexOf("q two")).toBeLessThan(screen.indexOf("answer two"))
      }
    )
    expect(result.record.prompts).toEqual(["q one", "q two"])
  })

  it("runs both turns through one session rather than reconnecting", async () => {
    const result = await runConversation(
      { scenario: { fallback: { steps: [{ kind: "text", delta: "acknowledged" }] } } },
      async (session) => {
        await session.send("one")
        await session.waitForTurnEnd(1)
        await session.send("two")
        await session.waitForTurnEnd(2)
      }
    )
    // The scripted agent counts prompts per session, so two prompts on one
    // record is the evidence that the session was not rebuilt in between.
    expect(result.record.prompts).toEqual(["one", "two"])
  })

  it("shows the reasoning indicator while the agent thinks", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "thinking", delta: "weighing the options" },
                { kind: "delay", ms: 400 },
                { kind: "text", delta: "decided" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("think")
        await session.waitForText("Thinking")
        await session.waitForText("decided")
      }
    )
  })

  it("hands the terminal back the way it found it", async () => {
    const result = await runConversation({ scenario: {} }, async (session) => {
      await session.waitForText("Ask, run /commands")
      expect(session.modes()).toMatchObject({ altScreen: true, cursorVisible: false })
    })
    // The state the user's shell inherits.
    expect(result.modesAtExit).toEqual({ altScreen: false, cursorVisible: true, mouse: [] })
  })
})
