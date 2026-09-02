/** @jest-environment node */
import { ALT_SCREEN_OFF, ALT_SCREEN_ON } from "../screen"
import {
  nodePtyAvailable,
  runNonTtyScenario,
  runPtyScenario,
  visibleText,
} from "./node-pty-harness"

const ptyTest = nodePtyAvailable() ? it : it.skip

describe("node-pty TUI harness", () => {
  jest.setTimeout(15_000)

  async function scenario(columns: number, rows: number) {
    const resized = { columns: Math.max(20, columns - 3), rows: Math.max(8, rows - 2) }
    const output = await runPtyScenario({ columns, rows }, resized)
    expect(output).toContain(ALT_SCREEN_ON)
    expect(output).toContain(`READY ${columns}x${rows}`)
    // A narrow terminal wraps the reply, so compare visible text.
    expect(visibleText(output)).toContain("deterministic reply")
    expect(output).toContain(`RESIZE ${resized.columns}x${resized.rows}`)
    expect(output).toContain(ALT_SCREEN_OFF)
    expect(output).toContain("CLEANUP")
  }

  ptyTest.each([
    [40, 12],
    [80, 24],
    [160, 50],
  ])("handles %sx%s, wheel input, resize, and interruption cleanup", scenario)

  // Known app defect, pinned rather than hidden: at 20x8 the App throws
  // React's "Maximum update depth exceeded" right after the first submit
  // (the transcript viewport and the composer fight over the 8 rows), so
  // the reply never settles. The from-source fixture crashed at startup, so
  // this never had a chance to show before the matrix ran the real bundle.
  // When the loop is fixed this pin fails, and the row moves back up.
  ;(nodePtyAvailable() ? it.failing : it.skip)(
    "20x8 still trips the transcript render loop after submit",
    async () => {
      await scenario(20, 8)
    }
  )

  it("uses plain scrollback output without screen control in a non-TTY", async () => {
    const output = await runNonTtyScenario()
    expect(output).toContain("LAYOUT scrollback")
    expect(output).toContain("EVENT text-delta:hello")
    expect(output).not.toContain(ALT_SCREEN_ON)
  })
})
