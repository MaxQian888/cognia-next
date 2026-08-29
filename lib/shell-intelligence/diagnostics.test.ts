import {
  commandNamesInLine,
  computeDiagnostics,
  isStaticallyKnownCommand,
  type CommandVerdict,
  type DiagnosticsInput,
} from "./diagnostics"
import type { ResolvedShell } from "./types"

const zsh: ResolvedShell = { path: "/bin/zsh", kind: "zsh", source: "setting" }

const messages = {
  commandNotFound: (name: string) => `not found: ${name}`,
  incompleteSyntax: () => "incomplete",
  shellUnavailable: (shell: string) => `no shell: ${shell}`,
  unsupportedShell: (shell: string) => `unsupported: ${shell}`,
}

/** Everything known except the names listed as unknown. */
const knowing =
  (unknown: string[]) =>
  (name: string): CommandVerdict =>
    unknown.includes(name) ? "unknown" : "known"

const run = (over: Partial<DiagnosticsInput>) =>
  computeDiagnostics({
    line: "",
    shell: zsh,
    availability: "full",
    submitted: false,
    idle: false,
    lookup: () => "known",
    messages,
    ...over,
  })

describe("computeDiagnostics — command-not-found commitment", () => {
  it("stays silent on a prefix that is still being typed", () => {
    expect(run({ line: "kub", lookup: knowing(["kub"]) })).toEqual([])
  })

  it("stays silent on a one-character word even once idle", () => {
    expect(run({ line: "k", idle: true, lookup: knowing(["k"]) })).toEqual([])
  })

  it("reports an idle word of at least two characters", () => {
    const out = run({ line: "ab", idle: true, lookup: knowing(["ab"]) })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ code: "command-not-found", from: 0, to: 2 })
  })

  it("reports as soon as whitespace commits the word, without waiting for idle", () => {
    const out = run({ line: "abcdef get pods", lookup: knowing(["abcdef"]) })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ from: 0, to: 6, message: "not found: abcdef" })
  })

  it("reports as soon as an operator commits the word", () => {
    const out = run({ line: "abcdef|", lookup: knowing(["abcdef"]) })
    expect(out).toHaveLength(1)
  })

  it("reports on submit even with no whitespace and no idle", () => {
    const out = run({ line: "ab", submitted: true, lookup: knowing(["ab"]) })
    expect(out).toHaveLength(1)
  })

  it("never reports a name whose answer has not arrived", () => {
    expect(run({ line: "abcdef ", lookup: () => "pending" })).toEqual([])
  })

  it("checks every command in a pipeline, not just the first", () => {
    const out = run({ line: "cat f | nope | wc -l", lookup: knowing(["nope"]) })
    expect(out).toHaveLength(1)
    expect(out[0].from).toBe(8)
    expect(out[0].to).toBe(12)
  })

  it("skips a path-like head — the host owns that error", () => {
    expect(run({ line: "./script.sh ", lookup: () => "unknown" })).toEqual([])
    expect(run({ line: "/usr/bin/thing ", lookup: () => "unknown" })).toEqual([])
    expect(run({ line: "~/bin/x ", lookup: () => "unknown" })).toEqual([])
  })

  it("skips a name this layer cannot resolve", () => {
    expect(run({ line: "$CMD ", lookup: () => "unknown" })).toEqual([])
    expect(run({ line: "'quoted' ", lookup: () => "unknown" })).toEqual([])
  })

  it("skips a redirect target", () => {
    expect(run({ line: "> out.txt", submitted: true, lookup: () => "unknown" })).toEqual([])
  })
})

describe("computeDiagnostics — syntax and shell", () => {
  it("reports an unterminated quote once idle, with its range", () => {
    const out = run({ line: `cat "x`, idle: true })
    expect(out).toEqual([
      expect.objectContaining({ code: "incomplete-syntax", from: 4, to: 6, severity: "warning" }),
    ])
  })

  it("stays silent on an unterminated quote that is still being typed", () => {
    expect(run({ line: `cat "x` })).toEqual([])
  })

  it("does not pile command errors on top of a broken quote", () => {
    const out = run({ line: `nope "x`, idle: true, lookup: () => "unknown" })
    expect(out.map((d) => d.code)).toEqual(["incomplete-syntax"])
  })

  it("reports an unavailable shell across the whole line", () => {
    const out = run({ line: "ls", availability: "shell-unavailable" })
    expect(out[0]).toMatchObject({
      code: "shell-unavailable",
      from: 0,
      to: 2,
      severity: "error",
      message: "no shell: /bin/zsh",
    })
  })

  it("distinguishes a shell the host lacks from one nobody can drive", () => {
    const out = run({
      line: "ls",
      availability: "shell-unavailable",
      reason: "unsupported-family",
    })
    expect(out[0].message).toBe("unsupported: /bin/zsh")
  })

  it("says nothing about the shell when it is fine", () => {
    expect(run({ line: "ls ", availability: "full" }).map((d) => d.code)).toEqual([])
  })

  it("keeps completing and reporting with no host — diagnostics are not gated on one", () => {
    const out = run({ line: "nope ", availability: "static-only", lookup: knowing(["nope"]) })
    expect(out.map((d) => d.code)).toEqual(["command-not-found"])
  })
})

describe("isStaticallyKnownCommand", () => {
  it("matches builtins and spec names case-insensitively", () => {
    expect(isStaticallyKnownCommand("CD", ["cd"], [])).toBe(true)
    expect(isStaticallyKnownCommand("git", [], ["git"])).toBe(true)
    expect(isStaticallyKnownCommand("nope", ["cd"], ["git"])).toBe(false)
  })
})

describe("commandNamesInLine", () => {
  it("returns each command head once, in order", () => {
    expect(commandNamesInLine("cat f | grep x && cat g", zsh)).toEqual(["cat", "grep"])
  })

  it("skips paths, opaque names and empty segments", () => {
    expect(commandNamesInLine("./x | $Y | 'z' | ok", zsh)).toEqual(["ok"])
  })

  it("looks inside a substitution", () => {
    expect(commandNamesInLine("echo $(kubectl get)", zsh)).toEqual(["echo", "kubectl"])
  })

  it("returns nothing for an empty line", () => {
    expect(commandNamesInLine("", zsh)).toEqual([])
  })
})
