import { buildNotificationSequence, emitDesktopNotification } from "./notify-desktop"
import type { TitleStream, TitleEnv } from "./terminal-title"

const ESC = "\x1b"
const BEL = "\x07"

describe("buildNotificationSequence", () => {
  it("emits both OSC 9 and OSC 777 with title + body", () => {
    const seq = buildNotificationSequence("cognia", "Response ready", { TERM: "xterm" })
    expect(seq).toContain(`${ESC}]9;cognia: Response ready${BEL}`)
    expect(seq).toContain(`${ESC}]777;notify;cognia;Response ready${ESC}\\`)
  })

  it("omits the body separator in OSC 9 when there is no body", () => {
    const seq = buildNotificationSequence("cognia", "", { TERM: "xterm" })
    expect(seq).toContain(`${ESC}]9;cognia${BEL}`)
    expect(seq).not.toContain("cognia: ")
  })

  it("falls back to 'cognia' when the title is empty", () => {
    expect(buildNotificationSequence("", "", { TERM: "xterm" })).toContain(`${ESC}]9;cognia${BEL}`)
  })

  it("strips control bytes from title and body", () => {
    const seq = buildNotificationSequence(`a${ESC}b`, `x${BEL}y`, { TERM: "xterm" })
    expect(seq).toContain("a b")
    expect(seq).toContain("x y")
  })

  it("wraps each sequence in the tmux DCS passthrough envelope under tmux", () => {
    const seq = buildNotificationSequence("cognia", "done", { TMUX: "/tmp/tmux-1000/default,1,0" })
    // Passthrough opens with ESC P tmux; and closes with ESC \.
    expect(seq).toContain(`${ESC}Ptmux;`)
    expect(seq.endsWith(`${ESC}\\`)).toBe(true)
    // The inner OSC's ESC is doubled inside the envelope.
    expect(seq).toContain(`${ESC}${ESC}]9;`)
  })

  it("detects tmux via a tmux-* TERM as well as $TMUX", () => {
    expect(buildNotificationSequence("c", "", { TERM: "tmux-256color" })).toContain(`${ESC}Ptmux;`)
  })

  it("emits the plain (non-tmux) form with an empty env", () => {
    const seq = buildNotificationSequence("c", "", {})
    expect(seq).not.toContain(`${ESC}Ptmux;`)
    expect(seq).toContain(`${ESC}]9;c${BEL}`)
  })
})

describe("emitDesktopNotification", () => {
  function sink(isTTY: boolean): { out: TitleStream; writes: string[] } {
    const writes: string[] = []
    return { out: { isTTY, write: (s: string) => writes.push(s) }, writes }
  }

  it("writes the sequence on a real TTY", () => {
    const { out, writes } = sink(true)
    emitDesktopNotification("cognia", "ready", out, { TERM: "xterm" } as TitleEnv)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain(`${ESC}]9;cognia: ready${BEL}`)
  })

  it("no-ops on a non-TTY sink", () => {
    const { out, writes } = sink(false)
    emitDesktopNotification("cognia", "ready", out, { TERM: "xterm" } as TitleEnv)
    expect(writes).toHaveLength(0)
  })

  it("no-ops on a dumb terminal", () => {
    const { out, writes } = sink(true)
    emitDesktopNotification("cognia", "ready", out, { TERM: "dumb" } as TitleEnv)
    expect(writes).toHaveLength(0)
  })
})
