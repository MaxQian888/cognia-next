/** Plan review must work through the real input router and terminal geometry. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runConversation } from "./conversation-driver"

jest.setTimeout(120_000)

describe("plan review in a terminal", () => {
  it("does not turn a project analysis into an execution approval", async () => {
    const analysis =
      "# Cognia 项目分析\n\n## 技术栈\n- Next.js frontend\n- Rust backend\n\n## 总结\n这是项目当前的结构。"
    const result = await runConversation(
      {
        scenario: {
          config: { permissionMode: "plan" },
          turns: [{ steps: [{ kind: "text", delta: analysis }] }],
        },
      },
      async (session) => {
        await session.send("analyze this project")
        await session.waitForTurnEnd(1)
        await session.waitForText("这是项目当前的结构")
        expect(session.screen()).not.toContain("Review plan")
        expect(session.screen()).not.toContain("Ready to code?")
      }
    )
    expect(result.record.prompts).toEqual(["analyze this project"])
  })

  it("scrolls the plan body on a short terminal before choosing an execution action", async () => {
    const plan =
      "# Implementation Plan\n\n" +
      Array.from(
        { length: 20 },
        (_, i) => `${i + 1}. Implement STEP_${String(i + 1).padStart(2, "0")} with tests`
      ).join("\n")
    const result = await runConversation(
      {
        geometry: { columns: 60, rows: 18 },
        scenario: {
          config: { permissionMode: "plan" },
          turns: [{ steps: [{ kind: "text", delta: plan }] }],
        },
      },
      async (session) => {
        await session.send("propose the implementation plan")
        await session.waitForText("Review plan")
        await session.waitForText("STEP_03")
        await session.raw("G")
        await session.waitForText("STEP_20")
        await session.press("enter")
        await session.waitForText("Enter select")
        await session.press("escape")
        await session.waitForNoText("Review plan")
      }
    )
    expect(result.record.prompts).toHaveLength(1)
  })

  it("returns from an external editor to review and executes exactly the edited revision", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-plan-editor-"))
    const revised = "# Reviewed Plan\n1. Add EDITED_REQUIREMENT\n2. Verify compatibility"
    const editor = path.join(dir, "edit.cjs")
    fs.writeFileSync(
      editor,
      `require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(revised)})`
    )
    try {
      const result = await runConversation(
        {
          geometry: { columns: 90, rows: 24 },
          scenario: {
            config: {
              permissionMode: "plan",
              editor: { command: process.execPath, args: [editor] },
            },
            turns: [
              {
                steps: [
                  {
                    kind: "text",
                    delta: "# Implementation Plan\n1. Add original feature\n2. Verify behavior",
                  },
                ],
              },
              { steps: [{ kind: "text", delta: "IMPLEMENTATION_RECEIVED" }] },
            ],
          },
        },
        async (session) => {
          await session.send("plan the change")
          await session.waitForText("Review plan")
          await session.raw("\u0007")
          await session.waitForText("EDITED_REQUIREMENT")
          await session.waitForText("Enter actions")
          await session.press("enter")
          await session.waitForText("Enter select")
          await session.press("enter")
          await session.waitForTurnEnd(2)
          await session.waitForText("IMPLEMENTATION_RECEIVED")
        }
      )
      expect(result.record.prompts).toHaveLength(2)
      expect(result.record.prompts[1]).toContain(revised)
      expect(result.record.prompts[1]).not.toContain("original feature")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
