/** @jest-environment node */
/**
 * Batch F: how the conversation behaves as a TERMINAL program.
 *
 * Geometry, resizing mid-stream, wide characters, scrollback keys, and what the
 * shell gets back at the end. These are the failures a unit test cannot see:
 * they are about columns and rows, not about state.
 */
import { nodePtyAvailable } from "./node-pty-harness"
import { runConversation } from "./conversation-driver"

const maybe = nodePtyAvailable() ? describe : describe.skip

const GEOMETRIES: Array<[number, number]> = [
  [20, 8],
  [40, 12],
  [80, 24],
  [160, 50],
]

maybe("conversation: terminal behaviour", () => {
  jest.setTimeout(180_000)

  it.each(GEOMETRIES)("holds a whole exchange at %sx%s", async (columns, rows) => {
    await runConversation(
      {
        geometry: { columns, rows },
        scenario: { turns: [{ steps: [{ kind: "text", delta: "a fitted reply" }] }] },
      },
      async (session) => {
        await session.send("hello")
        await session.waitForText("a fitted reply")
        // Nothing may be painted outside the terminal. A row wider than the
        // screen is a row the terminal wraps into the next one, which is how a
        // layout silently eats the composer.
        for (const row of session.rows()) {
          expect(row.length).toBeLessThanOrEqual(columns)
        }
        expect(session.rows().length).toBeLessThanOrEqual(rows)
      }
    )
  })

  it("survives a resize in the middle of a streaming turn", async () => {
    await runConversation(
      {
        geometry: { columns: 100, rows: 30 },
        scenario: {
          turns: [
            {
              steps: [
                { kind: "text", delta: "before the resize " },
                { kind: "delay", ms: 1_200 },
                { kind: "text", delta: "and after it" },
              ],
            },
          ],
        },
      },
      async (session) => {
        await session.send("stream")
        await session.waitForText("before the resize")
        await session.resize(60, 18)
        await session.waitForText("and after it")
        for (const row of session.rows()) expect(row.length).toBeLessThanOrEqual(60)
      }
    )
  })

  it("keeps a wide-character reply inside the terminal", async () => {
    await runConversation(
      {
        geometry: { columns: 40, rows: 14 },
        scenario: {
          turns: [
            {
              steps: [{ kind: "text", delta: "模型已经准备好了，随时可以开始工作。🚀 好的" }],
            },
          ],
        },
      },
      async (session) => {
        await session.send("status")
        await session.waitForText("模型已经准备好了")
        // Every CJK glyph is two columns. Measuring in code units instead lets
        // a row overflow by its own width again.
        for (const row of session.rows()) expect(row.length).toBeLessThanOrEqual(40)
      }
    )
  })

  it("frames a markdown table to the terminal, at every width", async () => {
    const table = [
      "| Model | Context | Note |",
      "| :-- | --: | :-: |",
      "| glm-5.3-flash | 128000 | fast |",
      "| 模型 | 8192 | ok |",
    ].join("\n")
    for (const [columns, rows] of [
      [100, 30],
      [46, 16],
    ] as Array<[number, number]>) {
      await runConversation(
        {
          geometry: { columns, rows },
          scenario: { turns: [{ steps: [{ kind: "text", delta: table }] }] },
        },
        async (session) => {
          await session.send("table")
          await session.waitForText("Context")
          const framed = session.rows().filter((row) => row.trimStart().startsWith("│ Model"))
          expect(framed.length).toBe(1)
          // The frame's rules and its body rows are the same width, or the
          // columns do not line up with the rule above them.
          const top = session.rows().find((row) => row.includes("┬"))
          expect(top).toBeDefined()
          expect(top!.length).toBe(framed[0].length)
          for (const row of session.rows()) expect(row.length).toBeLessThanOrEqual(columns)
        }
      )
    }
  })

  it("scrolls back through a long transcript and returns to the live tail", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the answer`).join("\n\n")
    await runConversation(
      {
        geometry: { columns: 80, rows: 20 },
        scenario: { turns: [{ steps: [{ kind: "text", delta: long }] }] },
      },
      async (session) => {
        await session.send("lots")
        await session.waitForText("line 60 of the answer")
        await session.press("pageUp")
        // Scrolled up: the tail is off screen and an earlier line is on it.
        await session.waitForNoText("line 60 of the answer")
        await session.press("pageDown")
        await session.waitForText("line 60 of the answer")
      }
    )
  })

  it("restores the terminal after a resize and an interrupted turn", async () => {
    const result = await runConversation(
      {
        geometry: { columns: 90, rows: 24 },
        scenario: {
          turns: [
            {
              steps: [{ kind: "text", delta: "working" }, { kind: "hold" }],
            },
          ],
        },
      },
      async (session) => {
        await session.send("start")
        await session.waitForText("working")
        await session.resize(70, 20)
        await session.press("escape")
        await session.waitForTurnEnd(1)
      }
    )
    expect(result.modesAtExit).toEqual({ altScreen: false, cursorVisible: true, mouse: [] })
  })
})
