/** @jest-environment node */
/**
 * Batch B: tool calls, tool failures, and the approval prompt.
 *
 * The approval is the one surface where the screen alone cannot prove
 * correctness: a prompt that closes looks the same whether the agent was told
 * "allow" or "deny". Every case here checks both what the user saw and what the
 * agent was actually told, which the scripted session records.
 */
import { nodePtyAvailable } from "./node-pty-harness"
import { runConversation } from "./conversation-driver"

const maybe = nodePtyAvailable() ? describe : describe.skip

maybe("conversation: tools and approvals", () => {
  jest.setTimeout(120_000)

  it("renders a tool call and its result", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "tool-call", id: "t1", toolName: "read", input: { path: "notes.md" } },
                { kind: "tool-result", id: "t1", toolName: "read", result: "two lines of notes" },
                { kind: "text", delta: "done reading" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("read notes")
        await session.waitForText("done reading")
        // The call names its target, so a user can tell which file was touched.
        expect(session.flat()).toContain("notes.md")
      }
    )
  })

  it("marks a failed tool as failed instead of quietly moving on", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "tool-call", id: "t1", toolName: "read", input: { path: "missing.md" } },
                {
                  kind: "tool-result",
                  id: "t1",
                  toolName: "read",
                  result: "ENOENT: no such file",
                  isError: true,
                },
                { kind: "text", delta: "could not read it" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("read gone")
        await session.waitForText("could not read it")
        // The failure glyph. A failed call that renders like a successful one
        // makes the reply's excuse look like a refusal rather than an outcome.
        expect(session.screen()).toContain("✗")
      }
    )
  })

  // Density. A read-heavy turn used to spend a row on every call, a blank row
  // after every row, and one line of protocol jargon per status tick, so the
  // reply it was all leading up to was pushed off a 30-row screen.
  it("folds a run of reads and keeps the whole turn on one screen", async () => {
    await runConversation(
      {
        geometry: { columns: 100, rows: 30 },
        scenario: {
          turns: [
            {
              steps: [
                { kind: "thinking", delta: "planning the reads" },
                { kind: "tool-call", id: "t1", toolName: "read", input: { path: "package.json" } },
                { kind: "tool-result", id: "t1", toolName: "read", result: "801 lines" },
                { kind: "tool-call", id: "t2", toolName: "read", input: { path: "README.md" } },
                { kind: "tool-result", id: "t2", toolName: "read", result: "122 lines" },
                { kind: "tool-call", id: "t3", toolName: "read", input: { path: "tsconfig.json" } },
                { kind: "tool-result", id: "t3", toolName: "read", result: "38 lines" },
                {
                  kind: "tool-call",
                  id: "t4",
                  toolName: "bash",
                  input: { command: "ls packages" },
                },
                {
                  kind: "tool-result",
                  id: "t4",
                  toolName: "bash",
                  result: "Operation not permitted",
                  isError: true,
                },
                { kind: "text", delta: "Here is what I found." },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("scan repo")
        await session.waitForText("Here is what I found")
        await session.waitForTurnEnd(1)
        const rows = session.rows()
        // Question to answer, which is the part of the screen the turn owns.
        const body = rows.slice(
          rows.findIndex((row) => row.includes("scan repo")),
          rows.findIndex((row) => row.includes("Here is what I found")) + 1
        )
        // The three reads are one summary row, not three cards.
        expect(body.filter((row) => row.includes("⚙")).length).toBe(1)
        expect(body.join("\n")).not.toContain("package.json")
        // The whole turn, question to answer, in a handful of rows.
        expect(body.filter((row) => row.trim() !== "").length).toBeLessThanOrEqual(6)
      }
    )
  })

  it("asks before a tool runs, and tells the agent allow when the user allows", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "ask-permission", toolName: "bash", input: { command: "echo hello" } },
                { kind: "text", delta: "ran it" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("echo hi")
        await session.waitForText("Allow bash?")
        // What is being approved has to be on screen ABOVE the answers. A bare
        // tool name reads as a UI that lost the command.
        expect(session.flat()).toContain("echo hello")
        await session.press("enter")
        await session.waitForText("ran it")
      }
    )
    expect(result.record.decisions).toEqual([{ toolName: "bash", decision: { decision: "allow" } }])
  })

  it("denies with a message the agent can act on", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "ask-permission", toolName: "bash", input: { command: "rm -rf /" } },
                { kind: "text", delta: "understood" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("wipe")
        await session.waitForText("Allow bash?")
        // Down twice: Allow once, Allow always, Deny. Each move is confirmed by
        // where the marker landed before the next key, so two arrow keys can
        // never arrive in one read and be parsed as a single sequence.
        await session.press("down")
        await session.waitForText("❯ Allow always")
        await session.press("down")
        await session.waitForText("❯ Deny")
        await session.press("enter")
        await session.waitForText("understood")
      }
    )
    expect(result.record.decisions).toHaveLength(1)
    expect(result.record.decisions[0].decision).toMatchObject({ decision: "deny" })
  })

  it("stops asking for the rest of the session after allow always", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "ask-permission", toolName: "bash", input: { command: "echo one" } },
                { kind: "text", delta: "first done" },
              ],
            },
            {
              steps: [
                { kind: "ask-permission", toolName: "bash", input: { command: "echo two" } },
                { kind: "text", delta: "second done" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("echo one")
        await session.waitForText("Allow bash?")
        await session.press("down")
        await session.waitForText("❯ Allow always")
        await session.press("enter")
        await session.waitForText("first done")

        await session.send("echo two")
        await session.waitForTurnEnd(2)
        await session.waitForText("second done")
        // The second call must not have raised a prompt at all.
        expect(session.flat()).not.toContain("Allow bash?")
      }
    )
    expect(result.record.decisions.map((d) => d.decision.decision)).toEqual([
      "allow_always",
      "allow",
    ])
  })

  // What a user sees when this is wrong: an approval on screen, and the agent's
  // other tools running behind it. Whatever they are about to answer, the work
  // has already happened.
  it("runs nothing else while an approval is on screen", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "ask-permission", toolName: "bash", input: { command: "echo one" } },
                { kind: "text", delta: "the tool ran" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("echo one")
        await session.waitForText("Allow bash?")
        // Nothing past the approval has reached the screen.
        expect(session.flat()).not.toContain("the tool ran")
        await session.press("enter")
        await session.waitForText("the tool ran")
      }
    )
    expect(result.record.decisions).toHaveLength(1)
  })

  it("answers the pending approval before stopping, rather than leaving it hanging", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "ask-permission", toolName: "bash", input: { command: "sleep 30" } },
                { kind: "text", delta: "should never run" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("sleep")
        await session.waitForText("Allow bash?")
        await session.press("escape")
        await session.waitForTurnEnd(1)
        expect(session.flat()).not.toContain("should never run")
      }
    )
    // Escape must reach the agent as a denial. An unanswered request leaves the
    // agent blocked on a prompt the user has already dismissed.
    expect(result.record.decisions).toHaveLength(1)
    expect(result.record.decisions[0].decision).toMatchObject({ decision: "deny" })
  })
})
