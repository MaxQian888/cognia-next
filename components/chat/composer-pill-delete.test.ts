import { pillDeleteRange } from "./composer-pill-delete"
import { parseSegments } from "@/lib/slash-commands/parse-segments"
import { computeCodeRanges } from "@/lib/chat/template/code-ranges"
import { splitParamSegments } from "@/lib/chat/template/param-segments"

const known = (n: string) => ["reset", "model", "git/commit"].includes(n)
const segs = (v: string) => parseSegments(v, known, { mentions: true })
/** The composer's real overlay list: mentions AND parameters split out. */
const richSegs = (v: string) => splitParamSegments(segs(v), computeCodeRanges(v))

describe("pillDeleteRange — backward (Backspace)", () => {
  it("deletes a whole command at the pill's right edge", () => {
    const v = "/reset"
    expect(pillDeleteRange(v, 6, segs(v), "backward")).toEqual({ start: 0, end: 6 })
  })

  it("deletes a just-picked command WITH its trailing space in one stroke", () => {
    const v = "/reset "
    // caret after the auto-inserted space
    expect(pillDeleteRange(v, 7, segs(v), "backward")).toEqual({ start: 0, end: 7 })
  })

  it("covers only the /name head, leaving args (args delete normally first)", () => {
    const v = "/model opus"
    // caret at the end → not at a pill edge → null (textarea deletes 's')
    expect(pillDeleteRange(v, 11, segs(v), "backward")).toBeNull()
    // caret right after '/model' → delete the command head only
    expect(pillDeleteRange(v, 6, segs(v), "backward")).toEqual({ start: 0, end: 6 })
  })

  it("handles nested command names (/git/commit)", () => {
    const v = "/git/commit"
    expect(pillDeleteRange(v, 11, segs(v), "backward")).toEqual({ start: 0, end: 11 })
  })

  it("deletes a whole @mention with its trailing space", () => {
    const v = "hi @lib/db "
    const s = segs(v)
    // mention token is "@lib/db" at [3,10); caret after the trailing space (11)
    expect(pillDeleteRange(v, 11, s, "backward")).toEqual({ start: 3, end: 11 })
    // caret at the mention's right edge (10)
    expect(pillDeleteRange(v, 10, s, "backward")).toEqual({ start: 3, end: 10 })
  })

  it("returns null when the caret is not hugging a pill", () => {
    const v = "/reset hello"
    expect(pillDeleteRange(v, 12, segs(v), "backward")).toBeNull() // mid-args
    expect(pillDeleteRange(v, 3, segs(v), "backward")).toBeNull() // inside the name
  })

  it("returns null for plain prose", () => {
    const v = "just text"
    expect(pillDeleteRange(v, 4, segs(v), "backward")).toBeNull()
  })
})

describe("pillDeleteRange — forward (Delete)", () => {
  it("deletes a whole command from its left edge, eating one trailing space", () => {
    const v = "/reset "
    expect(pillDeleteRange(v, 0, segs(v), "forward")).toEqual({ start: 0, end: 7 })
  })

  it("deletes a command head from the left edge without a trailing space", () => {
    const v = "/reset"
    expect(pillDeleteRange(v, 0, segs(v), "forward")).toEqual({ start: 0, end: 6 })
  })

  it("returns null when the caret is not at a pill's left edge", () => {
    const v = "/reset "
    expect(pillDeleteRange(v, 3, segs(v), "forward")).toBeNull()
  })
})

describe("pillDeleteRange — {{parameter}} pills", () => {
  it("deletes a whole parameter at its right edge", () => {
    const v = "fix {{module}}"
    expect(pillDeleteRange(v, 14, richSegs(v), "backward")).toEqual({ start: 4, end: 14 })
  })

  it("eats one trailing space so a just-inserted parameter goes in one keystroke", () => {
    const v = "fix {{module}} "
    expect(pillDeleteRange(v, 15, richSegs(v), "backward")).toEqual({ start: 4, end: 15 })
  })

  it("deletes a parameter forward from its left edge", () => {
    const v = "{{module}} now"
    expect(pillDeleteRange(v, 0, richSegs(v), "forward")).toEqual({ start: 0, end: 11 })
  })

  it("leaves the caret alone inside a parameter, so the token can be broken", () => {
    // Demoting a pill back to plain text by editing it is the escape hatch that
    // makes the textarea approach safe. Atomic deletion must not become a cage.
    const v = "fix {{module}}"
    expect(pillDeleteRange(v, 8, richSegs(v), "backward")).toBeNull()
    expect(pillDeleteRange(v, 8, richSegs(v), "forward")).toBeNull()
  })

  it("does not treat a parameter inside code as a pill", () => {
    const v = "`{{module}}`"
    expect(pillDeleteRange(v, 11, richSegs(v), "backward")).toBeNull()
  })
})
