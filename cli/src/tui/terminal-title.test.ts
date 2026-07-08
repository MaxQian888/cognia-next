/** @jest-environment jsdom */
import {
  MAX_TITLE_LEN,
  buildTitleSequence,
  computeTitle,
  applyTerminalTitle,
  resetTerminalTitle,
  type TitleStream,
} from "./terminal-title"

const ESC = "\x1b"
const BEL = "\x07"
const ST = `${ESC}\\`

function fakeStream(isTTY: boolean): { stream: TitleStream; writes: string[] } {
  const writes: string[] = []
  return { stream: { isTTY, write: (d) => writes.push(d) }, writes }
}

describe("computeTitle", () => {
  it("shows the app name and dir when idle", () => {
    expect(computeTitle({ busy: false, awaitingInput: false, dir: "cognia-next" })).toBe(
      "cognia - cognia-next"
    )
  })

  it("omits the separator when there is no dir", () => {
    expect(computeTitle({ busy: false, awaitingInput: false })).toBe("cognia")
  })

  it("marks the busy (working) state", () => {
    expect(computeTitle({ busy: true, awaitingInput: false, dir: "proj" })).toBe(
      "cognia [working] - proj"
    )
  })

  it("awaiting input wins over busy", () => {
    expect(computeTitle({ busy: true, awaitingInput: true, dir: "proj" })).toBe(
      "cognia [needs input] - proj"
    )
  })

  it("shows the background activity kind when idle and not awaiting", () => {
    expect(computeTitle({ busy: false, awaitingInput: false, activity: "goal", dir: "proj" })).toBe(
      "cognia [goal] - proj"
    )
  })

  it("busy takes precedence over a background activity label", () => {
    expect(computeTitle({ busy: true, awaitingInput: false, activity: "goal", dir: "proj" })).toBe(
      "cognia [working] - proj"
    )
  })

  it("honors a custom app label and falls back when blank", () => {
    expect(computeTitle({ busy: false, awaitingInput: false, app: "myapp", dir: "p" })).toBe(
      "myapp - p"
    )
    expect(computeTitle({ busy: false, awaitingInput: false, app: "   ", dir: "p" })).toBe(
      "cognia - p"
    )
  })

  it("ignores a whitespace-only activity label", () => {
    expect(computeTitle({ busy: false, awaitingInput: false, activity: "   ", dir: "p" })).toBe(
      "cognia - p"
    )
  })
})

describe("buildTitleSequence (terminal adaptation)", () => {
  it("emits an OSC 0 sequence with a BEL terminator on a plain terminal", () => {
    expect(buildTitleSequence("hi", { TERM: "xterm-256color" })).toBe(`${ESC}]0;hi${BEL}`)
  })

  it("also emits the screen window-rename sequence inside tmux ($TMUX)", () => {
    expect(buildTitleSequence("hi", { TMUX: "/tmp/tmux-1000/default,1,0" })).toBe(
      `${ESC}khi${ST}${ESC}]0;hi${BEL}`
    )
  })

  it("adapts to GNU screen via $STY", () => {
    expect(buildTitleSequence("hi", { STY: "1234.pts-0.host" })).toBe(
      `${ESC}khi${ST}${ESC}]0;hi${BEL}`
    )
  })

  it("adapts when TERM starts with tmux/screen", () => {
    expect(buildTitleSequence("x", { TERM: "tmux-256color" })).toBe(`${ESC}kx${ST}${ESC}]0;x${BEL}`)
    expect(buildTitleSequence("x", { TERM: "screen.linux" })).toBe(`${ESC}kx${ST}${ESC}]0;x${BEL}`)
  })

  it("strips control chars that would corrupt the OSC string", () => {
    expect(buildTitleSequence(`a${ESC}]2;evil${BEL}b\nc`, { TERM: "xterm" })).toBe(
      `${ESC}]0;a ]2;evil b c${BEL}`
    )
  })

  it("collapses whitespace runs and trims", () => {
    expect(buildTitleSequence("  a   b  ", { TERM: "xterm" })).toBe(`${ESC}]0;a b${BEL}`)
  })

  it("caps the title at MAX_TITLE_LEN", () => {
    const long = "x".repeat(MAX_TITLE_LEN + 50)
    const seq = buildTitleSequence(long, { TERM: "xterm" })
    expect(seq).toBe(`${ESC}]0;${"x".repeat(MAX_TITLE_LEN)}${BEL}`)
  })
})

describe("applyTerminalTitle / resetTerminalTitle", () => {
  it("writes the built sequence on a TTY", () => {
    const { stream, writes } = fakeStream(true)
    applyTerminalTitle("hi", stream, { TERM: "xterm" })
    expect(writes).toEqual([`${ESC}]0;hi${BEL}`])
  })

  it("clears the title on reset", () => {
    const { stream, writes } = fakeStream(true)
    resetTerminalTitle(stream, { TERM: "xterm" })
    expect(writes).toEqual([`${ESC}]0;${BEL}`])
  })

  it("is a no-op on a non-TTY stream", () => {
    const { stream, writes } = fakeStream(false)
    applyTerminalTitle("hi", stream, { TERM: "xterm" })
    resetTerminalTitle(stream, { TERM: "xterm" })
    expect(writes).toEqual([])
  })

  it("is a no-op on a dumb terminal even if it claims to be a TTY", () => {
    const { stream, writes } = fakeStream(true)
    applyTerminalTitle("hi", stream, { TERM: "dumb" })
    resetTerminalTitle(stream, { TERM: "dumb" })
    expect(writes).toEqual([])
  })
})
