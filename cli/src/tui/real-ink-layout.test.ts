/** @jest-environment node */
import path from "node:path"
import { spawnSync } from "node:child_process"

import { stringWidth } from "./markdown/width"

interface ProbeFrame {
  columns: number
  rows: number
  frame: string
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
    const fixture = path.join(__dirname, "fixtures", "real-ink-cursor-probe.tsx")
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    const probe = JSON.parse(result.stdout) as {
      hasVisualCaret: boolean
      showsNativeCursor: boolean
    }
    expect(probe.hasVisualCaret).toBe(true)
    expect(probe.showsNativeCursor).toBe(false)
  })
})
