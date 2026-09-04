/**
 * A terminal screen reconstructed from raw PTY bytes.
 *
 * PTY assertions used to run against the accumulated byte stream with the
 * escapes stripped, which is the history of everything ever painted rather than
 * what is on screen. Text the app had already erased still matched, a row that
 * had been overwritten matched twice, and nothing could tell whether a prompt
 * covered the transcript or docked under it. This applies the cursor movement
 * and the erases, so a test can assert the screen the user is looking at.
 *
 * The vocabulary is the one Ink actually emits (cursor positioning, erase line
 * and display, synchronized-update and alt-screen mode switches) plus the small
 * amount of scrolling a full-height frame needs. Anything else is skipped
 * rather than guessed at, which keeps this a reader of output and never a
 * second opinion about how a terminal behaves.
 */
import { graphemeSegments } from "../text/graphemes"
import { stringWidth } from "../markdown/width"

/** A cell holds one grapheme. The right half of a wide glyph holds "". */
type Cell = string

const ESC = "\u001b"
const BEL = "\u0007"

export interface TerminalScreenOptions {
  columns: number
  rows: number
}

export class TerminalScreen {
  private grid: Cell[][] = []
  private cursorRow = 0
  private cursorColumn = 0
  private pending = ""
  /** Whether the app is currently in the alternate screen buffer. */
  altScreen = false
  /** Whether the hardware cursor is currently visible. */
  cursorVisible = true
  /** Mouse tracking modes the app has turned on and not turned off. */
  readonly mouseModes = new Set<string>()

  constructor(private options: TerminalScreenOptions) {
    this.reset()
  }

  get columns(): number {
    return this.options.columns
  }

  get rows(): number {
    return this.options.rows
  }

  get cursor(): { row: number; column: number } {
    return { row: this.cursorRow, column: this.cursorColumn }
  }

  reset(): void {
    this.grid = Array.from({ length: this.options.rows }, () => this.blankRow())
    this.cursorRow = 0
    this.cursorColumn = 0
  }

  resize(columns: number, rows: number): void {
    this.options = { columns, rows }
    // A real terminal reflows. Ink repaints the whole frame after a resize, so
    // clearing is both simpler and closer to what the next frame will show than
    // a reflow this module would have to invent.
    this.reset()
  }

  /** Every visible row, right-trimmed, with the trailing blank rows dropped. */
  lines(): string[] {
    const rows = this.grid.map((row) => row.join("").replace(/\s+$/u, ""))
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop()
    return rows
  }

  /** The visible screen as text. */
  text(): string {
    return this.lines().join("\n")
  }

  /** The screen with runs of whitespace collapsed, for a phrase that a narrow
   * terminal wrapped across two rows. */
  flatText(): string {
    return this.lines().join(" ").replace(/\s+/gu, " ").trim()
  }

  write(chunk: string): void {
    const data = this.pending + chunk
    this.pending = ""
    let i = 0
    while (i < data.length) {
      const ch = data[i]
      if (ch === ESC) {
        const consumed = this.escape(data, i)
        if (consumed === -1) {
          // A control sequence split across two PTY reads. Hold it for the next.
          this.pending = data.slice(i)
          return
        }
        i += consumed
        continue
      }
      if (ch === "\n") {
        this.lineFeed()
        i += 1
        continue
      }
      if (ch === "\r") {
        this.cursorColumn = 0
        i += 1
        continue
      }
      if (ch === "\b") {
        this.cursorColumn = Math.max(0, this.cursorColumn - 1)
        i += 1
        continue
      }
      if (ch === BEL) {
        i += 1
        continue
      }
      // Take the whole printable run at once, then place it grapheme by grapheme
      // so a wide glyph claims both of its cells.
      let end = i
      while (end < data.length && !`\n\r\b${ESC}${BEL}`.includes(data[end])) end += 1
      this.print(data.slice(i, end))
      i = end
    }
  }

  private blankRow(): Cell[] {
    return Array.from({ length: this.options.columns }, () => " ")
  }

  private print(text: string): void {
    for (const { segment } of graphemeSegments(text)) {
      const width = Math.max(1, stringWidth(segment))
      if (this.cursorColumn + width > this.options.columns) {
        this.cursorColumn = 0
        this.lineFeed()
      }
      const row = this.grid[this.cursorRow]
      if (!row) return
      row[this.cursorColumn] = segment
      for (let k = 1; k < width; k++) row[this.cursorColumn + k] = ""
      this.cursorColumn += width
    }
  }

  private lineFeed(): void {
    if (this.cursorRow + 1 < this.options.rows) {
      this.cursorRow += 1
      return
    }
    this.grid.shift()
    this.grid.push(this.blankRow())
  }

  /** Consume one escape sequence starting at `start`. Returns its length, or -1
   * when the sequence is incomplete and the caller should buffer it. */
  private escape(data: string, start: number): number {
    const next = data[start + 1]
    if (next === undefined) return -1
    if (next === "[") {
      const match = /^\[([0-?]*)([ -/]*)([@-~])/u.exec(data.slice(start + 1))
      if (!match) return -1
      this.csi(match[1], match[3])
      return match[0].length + 1
    }
    if (next === "]") {
      // OSC. Terminated by BEL or ST. The payload is metadata (window title,
      // OSC-8 hyperlink target), never visible text, so it is dropped whole.
      const rest = data.slice(start)
      const bel = rest.indexOf(BEL)
      const st = rest.indexOf(`${ESC}\\`)
      if (bel === -1 && st === -1) return -1
      if (bel !== -1 && (st === -1 || bel < st)) return bel + 1
      return st + 2
    }
    // Two-character escapes such as the charset selectors Ink's reset emits.
    return 2
  }

  private csi(params: string, final: string): void {
    if (params.startsWith("?")) {
      this.privateMode(params.slice(1), final)
      return
    }
    const values = params.split(";").map((p) => (p === "" ? undefined : Number(p)))
    const n = values[0] ?? 1
    switch (final) {
      case "A":
        this.cursorRow = Math.max(0, this.cursorRow - n)
        return
      case "B":
        this.cursorRow = Math.min(this.options.rows - 1, this.cursorRow + n)
        return
      case "C":
        this.cursorColumn = Math.min(this.options.columns - 1, this.cursorColumn + n)
        return
      case "D":
        this.cursorColumn = Math.max(0, this.cursorColumn - n)
        return
      case "E":
        this.cursorRow = Math.min(this.options.rows - 1, this.cursorRow + n)
        this.cursorColumn = 0
        return
      case "F":
        this.cursorRow = Math.max(0, this.cursorRow - n)
        this.cursorColumn = 0
        return
      case "G":
        this.cursorColumn = this.clampColumn(n - 1)
        return
      case "d":
        this.cursorRow = this.clampRow(n - 1)
        return
      case "H":
      case "f":
        this.cursorRow = this.clampRow((values[0] ?? 1) - 1)
        this.cursorColumn = this.clampColumn((values[1] ?? 1) - 1)
        return
      case "J":
        this.eraseDisplay(values[0] ?? 0)
        return
      case "K":
        this.eraseLine(values[0] ?? 0)
        return
      case "X": {
        const row = this.grid[this.cursorRow]
        const limit = Math.min(this.options.columns, this.cursorColumn + n)
        for (let c = this.cursorColumn; c < limit; c++) row[c] = " "
        return
      }
      case "S":
        for (let k = 0; k < n; k++) {
          this.grid.shift()
          this.grid.push(this.blankRow())
        }
        return
      case "T":
        for (let k = 0; k < n; k++) {
          this.grid.pop()
          this.grid.unshift(this.blankRow())
        }
        return
      default:
        // SGR and everything else changes appearance, not layout.
        return
    }
  }

  private privateMode(params: string, final: string): void {
    if (final !== "h" && final !== "l") return
    const on = final === "h"
    for (const raw of params.split(";")) {
      switch (raw) {
        case "25":
          this.cursorVisible = on
          break
        case "1049":
          this.altScreen = on
          this.reset()
          break
        case "1000":
        case "1002":
        case "1006":
          if (on) this.mouseModes.add(raw)
          else this.mouseModes.delete(raw)
          break
        default:
          break
      }
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.grid = Array.from({ length: this.options.rows }, () => this.blankRow())
      return
    }
    if (mode === 0) {
      this.eraseLine(0)
      for (let r = this.cursorRow + 1; r < this.options.rows; r++) this.grid[r] = this.blankRow()
      return
    }
    this.eraseLine(1)
    for (let r = 0; r < this.cursorRow; r++) this.grid[r] = this.blankRow()
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.cursorRow]
    if (!row) return
    const from = mode === 0 ? this.cursorColumn : 0
    const to = mode === 1 ? this.cursorColumn + 1 : this.options.columns
    for (let c = from; c < to && c < this.options.columns; c++) row[c] = " "
  }

  private clampRow(row: number): number {
    return Math.min(this.options.rows - 1, Math.max(0, row))
  }

  private clampColumn(column: number): number {
    return Math.min(this.options.columns - 1, Math.max(0, column))
  }
}
