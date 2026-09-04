/** @jest-environment node */
import { nodePtyAvailable } from "./node-pty-harness"
import { runConversation } from "./conversation-driver"

const available = nodePtyAvailable()
const maybe = available ? describe : describe.skip

maybe("runConversation", () => {
  jest.setTimeout(120_000)

  it("streams a reply into the transcript", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [{ steps: [{ kind: "text", delta: "hello from the scenario" }] }],
        },
      },
      async (session) => {
        await session.send("ping")
        await session.waitForText("hello from the scenario")
      }
    )
    expect(result.record.prompts).toEqual(["ping"])
  })
})
