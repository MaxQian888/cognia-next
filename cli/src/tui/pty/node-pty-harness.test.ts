/** @jest-environment node */
import { ALT_SCREEN_OFF, ALT_SCREEN_ON } from "../screen"
import { nodePtyAvailable, runNonTtyScenario, runPtyScenario } from "./node-pty-harness"

const ptyTest = nodePtyAvailable() ? it : it.skip

describe("node-pty TUI harness", () => {
  jest.setTimeout(15_000)

  ptyTest.each([
    [20, 8],
    [40, 12],
    [80, 24],
    [160, 50],
  ])("handles %sx%s, wheel input, resize, and interruption cleanup", async (columns, rows) => {
    const resized = { columns: Math.max(20, columns - 3), rows: Math.max(8, rows - 2) }
    const output = await runPtyScenario({ columns, rows }, resized)
    expect(output).toContain(ALT_SCREEN_ON)
    expect(output).toContain(`READY ${columns}x${rows}`)
    expect(output).toContain("deterministic reply")
    expect(output).toContain(`RESIZE ${resized.columns}x${resized.rows}`)
    expect(output).toContain(ALT_SCREEN_OFF)
    expect(output).toContain("CLEANUP")
  })

  it("uses plain scrollback output without screen control in a non-TTY", async () => {
    const output = await runNonTtyScenario()
    expect(output).toContain("LAYOUT scrollback")
    expect(output).toContain("EVENT text-delta:hello")
    expect(output).not.toContain(ALT_SCREEN_ON)
  })
})
