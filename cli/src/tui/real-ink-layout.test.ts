/** @jest-environment node */
import path from "node:path"
import { spawnSync } from "node:child_process"

import { stringWidth } from "./markdown/width"

interface ProbeFrame {
  columns: number
  rows: number
  frame: string
}

interface CursorProbe {
  hasVisualCaret: boolean
  showsNativeCursor: boolean
  invertedCaret: boolean
  caretContext: string
}

/** Render the real composer through real Ink with colour forced on — chalk
 * disables styling for a non-TTY sink, which would hide the caret's escapes. */
function runCursorProbe(): CursorProbe {
  const fixture = path.join(__dirname, "fixtures", "real-ink-cursor-probe.tsx")
  const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "3" },
  })
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as CursorProbe
}

describe("real Ink layout probe", () => {
  it("keeps required regions inside the terminal-size matrix", () => {
    const fixture = path.join(__dirname, "fixtures", "real-ink-layout-probe.tsx")
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    const frames = JSON.parse(result.stdout) as ProbeFrame[]
    expect(frames).toHaveLength(4)

    for (const { columns, rows, frame } of frames) {
      const lines = frame.split("\n")
      expect(lines.length).toBeLessThanOrEqual(rows)
      expect(lines.every((line) => stringWidth(line) <= columns)).toBe(true)
      expect(frame).toContain("SELECTED")
      expect(frame).toContain("COMPOSER")
      if (rows >= 12) expect(frame).toContain("FOOTER")
    }
  })

  it("keeps the native terminal cursor hidden when the composer draws its own caret", () => {
    const probe = runCursorProbe()
    expect(probe.hasVisualCaret).toBe(true)
    expect(probe.showsNativeCursor).toBe(false)
  })

  // The composer hides the hardware cursor and draws its own, so a caret that
  // renders as nothing leaves the user with no cursor at all — which is exactly
  // what reverse video does to a full-block glyph.
  it("draws the end-of-line caret as a coloured block, not as reverse video", () => {
    const probe = runCursorProbe()
    expect(probe.invertedCaret).toBe(false)
    expect(probe.caretContext).toMatch(/\u001b\[[0-9;]*m$/)
  })
})
