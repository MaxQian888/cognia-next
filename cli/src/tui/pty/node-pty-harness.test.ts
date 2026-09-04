/** @jest-environment node */
import { ALT_SCREEN_OFF, ALT_SCREEN_ON } from "../screen"
import { nodePtyAvailable, runNonTtyScenario } from "./node-pty-harness"
import { runConversation } from "./conversation-driver"

const ptyTest = nodePtyAvailable() ? it : it.skip

describe("node-pty TUI harness", () => {
  jest.setTimeout(60_000)

  /**
   * A geometry that is guaranteed to DIFFER from the one it is derived from.
   *
   * The old derivation clamped at the 20x8 floor, so the smallest row in the
   * matrix resized itself to the size it already was. `useWindowSize` fires
   * nothing for an unchanged size, so the harness waited for a `RESIZE` marker
   * that could never arrive and timed out after ten seconds. That timeout was
   * recorded as an app render loop and pinned with `it.failing`. It was not one.
   */
  function resizedFrom(columns: number, rows: number) {
    return {
      columns: columns - 3 >= 20 ? columns - 3 : columns + 3,
      rows: rows - 2 >= 8 ? rows - 2 : rows + 2,
    }
  }

  async function scenario(columns: number, rows: number) {
    const resized = resizedFrom(columns, rows)
    expect(resized).not.toEqual({ columns, rows })
    const result = await runConversation(
      {
        geometry: { columns, rows },
        timeoutMs: 40_000,
        scenario: { turns: [{ steps: [{ kind: "text", delta: "deterministic reply" }] }] },
      },
      async (session) => {
        await session.send("hello")
        // The reply on the SCREEN, not in the byte history: a narrow terminal
        // wraps it, and `flat()` reads the wrapped rows back as one phrase.
        await session.waitForText("deterministic reply")
        // A wheel event, which the fullscreen layout captures.
        await session.raw("\u001b[<64;1;1M")
        await session.resize(resized.columns, resized.rows)
        expect(session.modes()).toMatchObject({ altScreen: true, cursorVisible: false })
      }
    )
    expect(result.transcript).toContain(ALT_SCREEN_ON)
    expect(result.transcript).toContain(ALT_SCREEN_OFF)
    // The terminal the user's shell gets back. Left in the alternate screen,
    // with the cursor hidden, or with the mouse still captured, it is unusable.
    expect(result.modesAtExit).toEqual({ altScreen: false, cursorVisible: true, mouse: [] })
    expect(result.record.prompts).toEqual(["hello"])
  }

  ptyTest.each([
    [20, 8],
    [40, 12],
    [80, 24],
    [160, 50],
  ])("handles %sx%s, wheel input, resize, and interruption cleanup", scenario)

  it("uses plain scrollback output without screen control in a non-TTY", async () => {
    const output = await runNonTtyScenario()
    expect(output).toContain("LAYOUT scrollback")
    expect(output).toContain("EVENT text-delta:hello")
    expect(output).not.toContain(ALT_SCREEN_ON)
  })
})
