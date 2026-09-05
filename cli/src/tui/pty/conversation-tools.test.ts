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
import { RENDER_DEFAULTS } from "../../config/schema"

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
        // The three reads share a compact summary and retain their targets.
        expect(body.filter((row) => row.includes("⚙")).length).toBe(1)
        for (const target of ["package.json", "README.md", "tsconfig.json"]) {
          expect(body.join("\n")).toContain(target)
        }
        // The whole turn, question to answer, in a handful of rows.
        expect(body.filter((row) => row.trim() !== "").length).toBeLessThanOrEqual(9)
      }
    )
  })

  it("shows grouped paths while held and expands structured results through real fullscreen scroll", async () => {
    await runConversation(
      {
        geometry: { columns: 60, rows: 24 },
        scenario: {
          config: {
            render: {
              ...RENDER_DEFAULTS,
              toolResultMaxLines: 12,
              fileLineNumbers: false,
              syntaxHighlightInline: false,
            },
          },
          turns: [
            {
              steps: [
                {
                  kind: "tool-call",
                  id: "read-a",
                  toolName: "read",
                  input: { path: "src/config.ts" },
                },
                { kind: "tool-result", id: "read-a", toolName: "read", result: "config source" },
                {
                  kind: "tool-call",
                  id: "read-b",
                  toolName: "read",
                  input: { path: "src/tools.ts" },
                },
                { kind: "tool-result", id: "read-b", toolName: "read", result: "tool source" },
                {
                  kind: "tool-call",
                  id: "read-c",
                  toolName: "read",
                  input: { path: "src/results.ts" },
                },
                {
                  kind: "tool-result",
                  id: "read-c",
                  toolName: "read",
                  result: {
                    exit_code: 0,
                    stdout:
                      "preview start\n" +
                      Array.from({ length: 30 }, (_, i) => `result row ${i + 1}`).join("\n"),
                  },
                },
                { kind: "hold" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("inspect grouped reads")
        // Earlier reads are committed; the last read remains in Inflight until stop.
        await session.waitForText("⚙ 2 reads · done")
        expect(session.modes().altScreen).toBe(true)
        for (const path of ["src/config.ts", "src/tools.ts", "src/results.ts"])
          expect(session.flat()).toContain(path)
        expect(session.flat()).not.toContain("Exit code:")
        // End the held turn so this assertion now exercises committed cells in
        // VirtualizedTranscript, not only the live Inflight region.
        await session.press("escape")
        await session.waitForTurnEnd(1)
        await session.waitForText("Turn stopped")
        await session.waitForText("⚙ 3 reads · done")
        for (const path of ["src/config.ts", "src/tools.ts", "src/results.ts"])
          expect(session.flat()).toContain(path)
        await session.press("ctrlO")
        await session.waitForText("Detail mode on")
        await session.waitForText("/expand")
        const tail = session.screen()
        for (let page = 0; page < 4 && !session.flat().includes("Exit code: 0"); page++) {
          const before = session.screen()
          await session.press("pageUp")
          await session.waitFor((screen) => screen !== before, {
            describe: "expanded tool output to scroll",
          })
        }
        await session.waitForText("Exit code: 0")
        expect(session.flat()).toContain("Stdout: preview start")
        expect(session.flat()).not.toContain('"exit_code"')
        expect(session.screen()).not.toBe(tail)
        await session.press("pageDown")
        await session.waitForText("/expand")
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
                {
                  kind: "ask-permission",
                  toolName: "bash",
                  input: { command: "chmod +x deploy.sh" },
                },
                { kind: "text", delta: "ran it" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("make it executable")
        await session.waitForText("Allow bash?")
        // What is being approved has to be on screen ABOVE the answers. A bare
        // tool name reads as a UI that lost the command.
        expect(session.flat()).toContain("chmod +x deploy.sh")
        await session.press("enter")
        await session.waitForText("ran it")
      }
    )
    expect(result.record.decisions).toEqual([{ toolName: "bash", decision: { decision: "allow" } }])
  })

  it("runs a read-only command without asking anybody", async () => {
    const result = await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                { kind: "ask-permission", toolName: "bash", input: { command: "ls -la packages" } },
                { kind: "text", delta: "three packages" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("what is in packages")
        await session.waitForText("three packages")
        // `bash` is rated `high` in the tool catalogue because `bash` can do
        // anything, so this used to open the same prompt as `rm -rf /`.
        expect(session.flat()).not.toContain("Allow bash?")
      }
    )
    expect(result.record.decisions).toEqual([{ toolName: "bash", decision: { decision: "allow" } }])
  })

  it("says which part of a command is the risky part", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                {
                  kind: "ask-permission",
                  toolName: "bash",
                  input: { command: "git push origin dev" },
                },
                { kind: "text", delta: "pushed" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("push it")
        await session.waitForText("Allow bash?")
        const flat = session.flat()
        expect(flat).toContain("git push mutates remote/history")
        expect(flat).toContain("[medium risk]")
        await session.press("enter")
        await session.waitForText("pushed")
      }
    )
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
        // A command the classifier calls catastrophic opens ON Deny, so the
        // answer a reflex Enter gives is the safe one. Nothing is pressed to
        // get there.
        await session.waitForText("❯ Deny")
        expect(session.flat()).toContain("[high risk]")
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
                {
                  kind: "ask-permission",
                  toolName: "bash",
                  input: { command: "chmod +x deploy.sh" },
                },
                { kind: "text", delta: "first done" },
              ],
            },
            {
              steps: [
                {
                  kind: "ask-permission",
                  toolName: "bash",
                  input: { command: "chmod +x deploy.sh" },
                },
                { kind: "text", delta: "second done" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("make it executable")
        await session.waitForText("Allow bash?")
        await session.press("down")
        await session.waitForText("❯ Allow always")
        await session.press("enter")
        await session.waitForText("first done")

        await session.send("do it again")
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

  // What a user agreed to was a command. Remembering the TOOL instead meant one
  // click on a build turned every future `git push --force` into a silent one.
  it("does not let allow always on one command cover a different one", async () => {
    await runConversation(
      {
        scenario: {
          turns: [
            {
              steps: [
                {
                  kind: "ask-permission",
                  toolName: "bash",
                  input: { command: "chmod +x deploy.sh" },
                },
                { kind: "text", delta: "marked" },
              ],
            },
            {
              steps: [
                {
                  kind: "ask-permission",
                  toolName: "bash",
                  input: { command: "git push --force origin dev" },
                },
                { kind: "text", delta: "pushed" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("make it executable")
        await session.waitForText("Allow bash?")
        await session.press("down")
        await session.waitForText("❯ Allow always")
        await session.press("enter")
        await session.waitForText("marked")

        await session.send("now force push")
        // Still asked, and the prompt names what makes this one different.
        await session.waitForText("git push mutates remote/history")
        await session.press("enter")
        await session.waitForText("pushed")
      }
    )
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
                { kind: "ask-permission", toolName: "bash", input: { command: "pnpm publish" } },
                { kind: "text", delta: "the tool ran" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("publish it")
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
                {
                  kind: "ask-permission",
                  toolName: "bash",
                  input: { command: "docker compose up -d" },
                },
                { kind: "text", delta: "should never run" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("bring it up")
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
