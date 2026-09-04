/** @jest-environment node */
/**
 * Batch D: failures, and what the session can still do afterwards.
 *
 * The thing that must never happen is a failure that reads like a completed
 * turn. Every case here checks that the reason is on screen and that the
 * session is still usable, or honestly says it is not.
 */
import { nodePtyAvailable } from "./node-pty-harness"
import { runConversation } from "./conversation-driver"

const maybe = nodePtyAvailable() ? describe : describe.skip

maybe("conversation: failures and recovery", () => {
  jest.setTimeout(120_000)

  it("shows the reason a turn failed instead of an empty reply", async () => {
    await runConversation(
      {
        scenario: {
          turns: [{ steps: [{ kind: "fail", message: "provider returned 503" }] }],
        },
      },
      async (session) => {
        await session.send("hello")
        await session.waitForText("provider returned 503")
      }
    )
  })

  it("keeps the partial reply a failed turn had already streamed", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "text", delta: "here is the first half" },
                { kind: "fail", message: "stream closed early" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("write")
        await session.waitForText("stream closed early")
        // Text the model already produced is work the user paid for. Throwing
        // it away on failure loses the only part of the turn that succeeded.
        expect(session.flat()).toContain("here is the first half")
      }
    )
  })

  it("takes the next turn after a failed one", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            { steps: [{ kind: "fail", message: "transient upstream error", recoverable: true }] },
            { steps: [{ kind: "text", delta: "recovered fine" }] },
          ],
        },
      },
      async (session) => {
        await session.send("first")
        await session.waitForText("transient upstream error")
        await session.send("second")
        await session.waitForText("recovered fine")
      }
    )
    expect(result.record.prompts).toEqual(["first", "second"])
  })

  it("does not report a failed turn as a completed one", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [{ kind: "fail", message: "model refused the request" }],
              // A reply the turn would have resolved with if it had not thrown.
              reply: "all done",
            },
          ],
        },
      },
      async (session) => {
        await session.send("do it")
        await session.waitForText("model refused the request")
        expect(session.flat()).not.toContain("all done")
      }
    )
  })

  it("fails a turn whose tool errored without pretending the tool worked", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "tool-call", id: "t1", toolName: "bash", input: { command: "false" } },
                {
                  kind: "tool-result",
                  id: "t1",
                  toolName: "bash",
                  result: "exit status 1",
                  isError: true,
                },
                { kind: "fail", message: "could not continue after the tool failed" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("run it")
        await session.waitForText("could not continue after the tool failed")
        expect(session.screen()).toContain("✗")
      }
    )
  })
})
