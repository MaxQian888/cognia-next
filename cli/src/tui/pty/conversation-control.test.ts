/** @jest-environment node */
/**
 * Batch C: control of a turn that is already running.
 *
 * Stopping, queueing, and the exit ladder. A stop that does not reach the agent
 * is the worst kind of failure here: the UI says the turn ended, and the agent
 * keeps spending money and running tools. Every case checks the agent's own
 * record as well as the screen.
 */
import { nodePtyAvailable } from "./node-pty-harness"
import { runConversation } from "./conversation-driver"

const maybe = nodePtyAvailable() ? describe : describe.skip

maybe("conversation: run control", () => {
  jest.setTimeout(120_000)

  it("stops a streaming turn on Esc and says so", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "text", delta: "starting a long answer" },
                { kind: "hold" },
                { kind: "text", delta: "this tail must never render" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("long one")
        await session.waitForText("starting a long answer")
        await session.press("escape")
        await session.waitForText("Turn stopped by user")
        await session.waitForTurnEnd(1)
        expect(session.flat()).not.toContain("this tail must never render")
      }
    )
    // The abort has to reach the agent, not just close the UI.
    expect(result.record.aborted).toBe(1)
  })

  it("leaves the session usable after a stop", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [{ kind: "text", delta: "long one" }, { kind: "hold" }],
            },
            { steps: [{ kind: "text", delta: "second answer" }] },
          ],
        },
      },
      async (session) => {
        await session.send("start")
        await session.waitForText("long one")
        await session.press("escape")
        await session.waitForTurnEnd(1)
        await session.send("carry on")
        await session.waitForText("second answer")
      }
    )
    expect(result.record.prompts).toEqual(["start", "carry on"])
  })

  it("holds a message typed during a turn and sends it when the turn ends", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                // Long enough that the keystrokes below always land inside the
                // turn even on a loaded machine, and no longer: the pause only
                // bounds the failure, the assertion is on what the agent was
                // told. The composer confirms each character on screen before
                // the next, so the typing is paced by the app, not by a guess.
                { kind: "delay", ms: 10_000 },
                { kind: "text", delta: "first answer" },
              ],
            },
            { steps: [{ kind: "text", delta: "second answer" }] },
          ],
        },
      },
      async (session) => {
        await session.send("first")
        // Typed while the first turn is still streaming.
        await session.type("queued")
        await session.press("enter")
        await session.waitForText("first answer")
        await session.waitForText("second answer")
      }
    )
    // Delivered once, in order, and marked as steering rather than as a fresh
    // question, so the agent can tell a mid-turn nudge from a new request. A
    // queue that drops or duplicates is worse than one that refuses input.
    expect(result.record.prompts).toEqual(["first", "By the way (steering): queued"])
  })

  it("asks for a second Ctrl+C before quitting an idle session", async () => {
    await runConversation({ scenario: {} }, async (session) => {
      await session.waitForText("Ask, run /commands")
      await session.press("ctrlC")
      // One press must not quit. A single stray Ctrl+C ending the session is
      // how a long conversation gets lost. Wait for the composer to come back
      // rather than reading the screen mid-repaint.
      await session.waitForText("Press Ctrl+C again to exit")
      await session.waitForText("Ask, run /commands")
    })
  })

  it("clears the composer with Ctrl+C rather than quitting", async () => {
    await runConversation({ scenario: {} }, async (session) => {
      await session.type("draft")
      await session.press("ctrlC")
      await session.waitForNoText("draft")
      // Still alive, and not warning about an exit it is not about to make.
      await session.waitForText("Ask, run /commands")
      expect(session.flat()).not.toContain("Press Ctrl+C again to exit")
    })
  })

  it("stops a turn on Ctrl+C instead of arming the exit ladder", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [{ kind: "text", delta: "working on it" }, { kind: "hold" }],
            },
          ],
        },
      },
      async (session) => {
        await session.send("start")
        await session.waitForText("working on it")
        await session.press("ctrlC")
        await session.waitForText("Turn stopped by user")
        await session.waitForTurnEnd(1)
        // Ctrl+C during a turn stops the turn. It must not also arm the exit
        // ladder, or the next one quits a session the user only meant to stop.
        expect(session.flat()).not.toContain("Press Ctrl+C again to exit")
      }
    )
    expect(result.record.aborted).toBe(1)
  })
})
