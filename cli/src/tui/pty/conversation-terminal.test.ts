/** @jest-environment node */
/**
 * Batch F: how the conversation behaves as a TERMINAL program.
 *
 * Geometry, resizing mid-stream, wide characters, scrollback keys, and what the
 * shell gets back at the end. These are the failures a unit test cannot see:
 * they are about columns and rows, not about state.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  it("returns from !top on Ctrl+C and accepts another conversation", async () => {
    const result = await runConversation(
      {
        geometry: { columns: 100, rows: 30 },
        scenario: { turns: [{ steps: [{ kind: "text", delta: "reply after top" }] }] },
        timeoutMs: 30_000,
      },
      async (session) => {
        await session.type("!top")
        await session.press("enter")
        await session.waitFor((screen) => /Processes:|Tasks:/.test(screen))
        expect(session.modes().mouse).toEqual([])
        await session.raw("\x03")
        await session.waitFor(
          (screen) => screen.includes("Ask, run /commands") && !/Processes:|Tasks:/.test(screen)
        )
        expect(session.modes().altScreen).toBe(true)
        expect(session.modes().mouse).toContain("1000")
        expect(session.screen()).not.toContain("/analyze to debug")
        await session.send("hello after top")
        await session.waitForText("reply after top")
        await session.waitForTurnEnd(1)
        await session.type("!top")
        await session.press("enter")
        await session.waitFor((screen) => /Processes:|Tasks:/.test(screen))
        await session.raw("\x03")
        await session.waitFor(
          (screen) => screen.includes("Ask, run /commands") && !/Processes:|Tasks:/.test(screen)
        )
        await session.press("ctrlC")
        await session.waitForText("Press Ctrl+C again to exit")
      }
    )
    expect(result.record.prompts).toEqual(["hello after top"])
    expect(result.modesAtExit).toEqual({ altScreen: false, cursorVisible: true, mouse: [] })
  })

  it("keeps pasted image labels inside a narrow composer and sends the correct attachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cognia-pasted-image-"))
    const file = join(dir, "屏幕 shot.png")
    writeFileSync(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=",
        "base64"
      )
    )
    try {
      const result = await runConversation(
        {
          geometry: { columns: 40, rows: 14 },
          scenario: {
            turns: [{ steps: [{ kind: "text", delta: "image received" }] }],
          },
        },
        async (session) => {
          await session.type("beforeafter")
          for (let i = 0; i < 5; i++) await session.press("left")
          await session.raw(`\x1b[200~"${file}"\x1b[201~`)
          await session.waitForText("before[Image 1]")
          expect(session.screen()).toContain("after")
          expect(session.screen()).not.toContain("shot.png")
          const rows = session.rows()
          const imageRow = rows.findIndex((row) => row.includes("[Image 1]"))
          expect(imageRow).toBeGreaterThan(0)
          expect(imageRow).toBeLessThan(13)
          await session.press("enter")
          await session.waitForText("image received")
          await session.waitForTurnEnd(1)
          await session.waitForText("[Image 1]")
          expect(session.screen()).not.toContain("shot.png")
        }
      )
      expect(result.record.prompts).toEqual([`before@"${file}"after`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("opens slash submenus and a parameter form without executing a command", async () => {
    const result = await runConversation(
      { geometry: { columns: 100, rows: 30 }, scenario: {}, timeoutMs: 30_000 },
      async (session) => {
        await session.type("/skil")
        await session.waitForText("Enter open")
        await session.waitFor((screen) =>
          screen.split("\n").some((row) => row.includes("/skil") && row.includes("█"))
        )
        await session.press("enter")
        await session.waitForText("/skill › actions")
        expect(session.screen()).not.toContain("panel | list")
        await session.type("create")
        await session.waitForText("❯ create")
        await session.waitForText("/skill create")
        await session.press("enter")
        await session.waitForText("Name*:")
        await session.waitForText("Enter submit · Esc cancel")
        await session.press("escape")
        await session.waitForNoText("Name*:")
        await session.type("composer restored")
        await session.waitForText("composer restored")
      }
    )
    expect(result.record.prompts).toEqual([])
  })

  it("completes a filtered slash subcommand and preserves its typed argument", async () => {
    const result = await runConversation(
      { geometry: { columns: 100, rows: 30 }, scenario: {}, timeoutMs: 30_000 },
      async (session) => {
        await session.type("/skill")
        await session.waitFor((screen) =>
          screen.split("\n").some((row) => row.includes("/skill") && row.includes("█"))
        )
        await session.waitForText("Enter open")
        await session.press("tab")
        await session.waitForText("/skill › actions")
        await session.type("en")
        await session.waitForText("❯ enable")
        await session.waitForText("/skill en")
        await session.press("tab")
        await session.waitFor((screen) =>
          screen.split("\n").some((row) => row.includes("/skill enable") && row.includes("█"))
        )
        await session.type("my-skill-id")
        await session.waitForText("/skill enable my-skill-id")
        await session.press("tab")
        await session.waitForText("/skill enable my-skill-id")
      }
    )
    expect(result.record.prompts).toEqual([])
  })

  it("aligns reasoning effort labels with the slider positions", async () => {
    await runConversation(
      { geometry: { columns: 120, rows: 24 }, scenario: {} },
      async (session) => {
        await session.type("/effort")
        await session.raw("\r")
        await session.waitForText("Reasoning effort")
        await session.raw("5")
        await session.waitForText("maximum reasoning budget")
        const lines = session.screen().split("\n")
        const track = lines.find((line) => line.includes("Faster"))!
        const labels = lines[lines.indexOf(track) + 1]
        expect(labels.indexOf("max") + 1).toBe(track.indexOf("◉"))
      }
    )
  })

  it("supports screen-reader keyboard conversation without alternate screen, mouse capture, or a decorative caret", async () => {
    const result = await runConversation(
      {
        geometry: { columns: 100, rows: 30 },
        scenario: {
          config: { screenReader: true },
          turns: [
            {
              steps: [
                { kind: "text", delta: "reader first segment " },
                { kind: "delay", ms: 200 },
                { kind: "text", delta: "reader completed" },
              ],
            },
            { steps: [{ kind: "text", delta: "reader followup accepted" }] },
          ],
        },
      },
      async (session) => {
        expect(session.modes().altScreen).toBe(false)
        expect(session.modes().mouse).toEqual([])
        await session.send("hello reader")
        await session.waitForText("reader first segment")
        await session.waitForTurnEnd(1)
        await session.waitForText("reader completed")
        await session.send("followup")
        await session.waitForTurnEnd(2)
        await session.waitForText("reader followup accepted")
      }
    )
    expect(result.record.prompts).toEqual(["hello reader", "followup"])
    expect(result.transcript).not.toMatch(/\u001b\[\?(?:1049|1047|47|1000|1002|1003|1006)h/u)
    expect(result.transcript).not.toContain("█")
    expect(result.modesAtExit).toEqual({ altScreen: false, cursorVisible: true, mouse: [] })
  })

  it("browses settings without mutating values, saves explicit edits, and fits the lower panel after resize", async () => {
    const home = mkdtempSync(join(tmpdir(), "cognia-settings-navigation-"))
    const configPath = join(home, "config.json")
    const saved = () => (existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {})
    try {
      await runConversation(
        { home, geometry: { columns: 100, rows: 30 }, scenario: { config: { theme: "dark" } } },
        async (session) => {
          await session.type("/settings")
          await session.waitFor((screen) =>
            screen.split("\n").some((row) => row.includes("› /settings") && row.includes("█"))
          )
          await session.press("enter")
          await session.waitForText("[Model & Reasoning]")
          await session.press("tab")
          await session.waitForText("[Appearance]")
          await session.waitForText("Theme dark")
          await session.waitFor((screen) => {
            const lines = screen.split("\n")
            const bottom = lines.findLastIndex((row) => row.includes("╰") && row.includes("╯"))
            return bottom >= 0 && Boolean(lines[bottom + 1]?.includes("anthropic"))
          })
          const appearanceRows = session.rows()
          const appearanceTop = appearanceRows.findIndex((row) => row.includes("Settings"))
          const borderBottom = appearanceRows.findLastIndex(
            (row) => row.includes("╰") && row.includes("╯")
          )
          expect(borderBottom).toBeGreaterThan(appearanceTop)
          expect(appearanceRows[borderBottom + 1]?.trim()).toBeTruthy()
          await session.press("right")
          await session.waitForText("[Display]")
          await session.press("left")
          await session.waitForText("[Appearance]")
          expect(saved().theme).toBeUndefined()
          await session.press("enter")
          await session.waitForText("Enter save")
          await session.press("right")
          await session.waitForText("‹ light ›")
          expect(saved().theme).toBeUndefined()
          await session.press("escape")
          await session.waitForText("Theme dark")
          expect(saved().theme).toBeUndefined()
          await session.press("enter")
          await session.waitForText("Enter save")
          await session.press("right")
          await session.waitForText("‹ light ›")
          await session.press("enter")
          await session.waitForText("Enter edit/open")
          expect(saved().theme).toBe("light")
          await session.press("tab")
          await session.waitForText("[Display]")
          expect(session.rows().findIndex((row) => row.includes("Settings"))).toBeLessThan(
            appearanceTop
          )
          await session.press("down")
          await session.waitForText("2/")
          await session.press("down")
          await session.waitForText("3/")
          await session.raw(" ")
          await session.waitFor((screen) =>
            screen
              .split("\n")
              .some((row) => row.includes("Syntax-highlight") && row.includes("[ ]"))
          )
          expect(saved().render.syntaxHighlightInline).toBe(false)
          await session.resize(36, 12)
          await session.waitForText("[Display]")
          expect(session.rows().filter((row) => row.includes("[Display]"))).toHaveLength(1)
          expect(session.rows().every((row) => row.length <= 36)).toBe(true)
          await session.press("tab")
          await session.waitForText("[Tools & Skills]")
          expect(saved().theme).toBe("light")
        }
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

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
