import { describeCursor, findUnterminatedQuote, segmentCommandLine } from "./segments"

/** Heads of every segment, in order — the "how many commands is this?" view. */
const heads = (line: string) => segmentCommandLine(line).map((s) => s.head?.value ?? null)

/** Describe the cursor at the `|` marker in `line` (the marker is removed). */
function at(marked: string) {
  const cursor = marked.indexOf("│")
  const line = marked.replace("│", "")
  const ctx = describeCursor(line, cursor)
  if (!ctx) throw new Error("cursor out of range")
  return ctx
}

describe("segmentCommandLine", () => {
  it("returns one segment for a plain command", () => {
    expect(heads("ls -la")).toEqual(["ls"])
  })

  it("splits a pipeline into one segment per command", () => {
    expect(heads("cat foo | grep bar | wc -l")).toEqual(["cat", "grep", "wc"])
  })

  it("splits on boolean operators and separators", () => {
    expect(heads("a && b || c ; d & e")).toEqual(["a", "b", "c", "d", "e"])
  })

  it("skips leading environment assignments when finding the head", () => {
    expect(heads("FOO=1 BAR=2 npm run dev")).toEqual(["npm"])
  })

  it("does not mistake a redirect target for a command", () => {
    expect(heads("cmd > out.txt")).toEqual(["cmd"])
    // The target is the segment's only word — still not a command.
    expect(segmentCommandLine("> out.txt")[0].head).toBeNull()
  })

  it("gives a substitution its own command context", () => {
    expect(heads("echo $(git log)")).toEqual(["echo", "git", null])
    expect(heads("echo `date`")).toEqual(["echo", "date", null])
  })

  it("gives a subshell its own command context", () => {
    expect(heads("(cd /tmp && ls)")).toEqual([null, "cd", "ls", null])
  })

  it("covers every offset in the line with exactly one segment", () => {
    const line = "cat foo | grep bar"
    const segments = segmentCommandLine(line)
    expect(segments[0].start).toBe(0)
    expect(segments[segments.length - 1].end).toBe(line.length)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].start).toBeGreaterThanOrEqual(segments[i - 1].end)
    }
  })
})

describe("describeCursor", () => {
  it("completes the head of a fresh line", () => {
    const ctx = at("kub│")
    expect(ctx.role).toBe("head")
    expect(ctx.token.value).toBe("kub")
    expect([ctx.token.start, ctx.token.end]).toEqual([0, 3])
  })

  it("completes an argument once a head exists", () => {
    const ctx = at("cat ./sr│")
    expect(ctx.role).toBe("argument")
    expect(ctx.token.value).toBe("./sr")
    expect([ctx.token.start, ctx.token.end]).toEqual([4, 8])
    expect(ctx.segment.head?.value).toBe("cat")
  })

  it("synthesizes an empty argument token on trailing whitespace", () => {
    const ctx = at("cat │")
    expect(ctx.role).toBe("argument")
    expect(ctx.token.value).toBe("")
    expect([ctx.token.start, ctx.token.end]).toEqual([4, 4])
  })

  it("treats the word after a pipe as a HEAD, not an argument of the first command", () => {
    const ctx = at("cat foo | gre│")
    expect(ctx.role).toBe("head")
    expect(ctx.token.value).toBe("gre")
    expect([ctx.token.start, ctx.token.end]).toEqual([10, 13])
  })

  it("treats the position right after an operator as a fresh head", () => {
    for (const marked of ["cat foo |│", "cat foo | │", "a && │", "a; │"]) {
      const ctx = at(marked)
      expect(ctx.role).toBe("head")
      expect(ctx.token.value).toBe("")
    }
  })

  it("treats the word inside a substitution as a head", () => {
    const ctx = at("echo $(gre│")
    expect(ctx.role).toBe("head")
    expect(ctx.token.value).toBe("gre")
  })

  it("resumes the parent command after a substitution closes", () => {
    const ctx = at("echo $(date) rea│")
    expect(ctx.role).toBe("argument")
    expect(ctx.token.value).toBe("rea")
    expect(ctx.segment.head?.value).toBe("echo")
  })

  it("treats a redirect target as a path, never a command", () => {
    expect(at("cmd > ou│").role).toBe("redirect-target")
    expect(at("cmd > │").role).toBe("redirect-target")
    expect(at("cmd 2>> er│").role).toBe("redirect-target")
  })

  it("keeps completing the head after leading assignments", () => {
    const ctx = at("FOO=1 np│")
    expect(ctx.role).toBe("head")
    expect(ctx.token.value).toBe("np")
  })

  it("treats the assignment itself as an argument, not a command name", () => {
    expect(at("FOO=1│").role).toBe("argument")
  })

  it("collects the prior arguments a CLI spec walks", () => {
    const ctx = at("git remote ad│")
    expect(ctx.priorArguments).toEqual(["remote"])
    expect(ctx.role).toBe("argument")
    expect(ctx.segment.head?.value).toBe("git")
  })

  it("excludes redirects and their targets from the prior arguments", () => {
    const ctx = at("git log > out.txt --one│")
    expect(ctx.priorArguments).toEqual(["log"])
  })

  it("scopes prior arguments to the cursor's own command", () => {
    const ctx = at("git log | git remote │")
    expect(ctx.priorArguments).toEqual(["remote"])
  })

  it("returns null for a cursor outside the line", () => {
    expect(describeCursor("ls", -1)).toBeNull()
    expect(describeCursor("ls", 3)).toBeNull()
  })
})

describe("findUnterminatedQuote", () => {
  it("reports the range of an unclosed quote", () => {
    expect(findUnterminatedQuote(`cat "unclosed`)).toEqual({ from: 4, to: 13, quote: '"' })
    expect(findUnterminatedQuote(`cat 'x`)).toEqual({ from: 4, to: 6, quote: "'" })
  })

  it("reports a trailing escape", () => {
    expect(findUnterminatedQuote("cat foo\\")?.quote).toBe("\\")
  })

  it("returns null for a well-formed line", () => {
    expect(findUnterminatedQuote(`cat "closed" 'too'`)).toBeNull()
    expect(findUnterminatedQuote(`echo "$(date)"`)).toBeNull()
    expect(findUnterminatedQuote(`echo "before $(date) after"`)).toBeNull()
    expect(findUnterminatedQuote("")).toBeNull()
  })
})
