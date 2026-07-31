import {
  BUILTIN_QUICK_FIX_MATCHERS,
  firstWindowMatch,
  windowOutput,
  gitSimilarCommand,
  gitTwoDashes,
  gitPushSetUpstream,
  gitCreatePr,
  pwshGeneralError,
  pwshUnixCommandNotFoundError,
  type QuickFixMatcher,
  type QuickFixAction,
} from "./matchers"

/** getActions with no output match (the evaluator's outputMatch=null path). */
function noMatch(matcher: QuickFixMatcher, commandLine: string, windowLines: string[] = []) {
  return matcher.getActions({
    commandLine,
    outputLines: windowLines,
    windowLines,
    outputMatch: null,
  })
}

/** Run one matcher end-to-end the way the evaluator does. */
function run(
  matcher: QuickFixMatcher,
  commandLine: string,
  outputLines: string[]
): QuickFixAction[] {
  let windowLines: string[] = []
  let outputMatch: RegExpMatchArray | null = null
  if (matcher.outputMatcher) {
    windowLines = windowOutput(outputLines, matcher.outputMatcher)
    outputMatch = firstWindowMatch(windowLines, matcher.outputMatcher.lineMatcher)?.match ?? null
  }
  return matcher.getActions({ commandLine, outputLines, windowLines, outputMatch })
}

function byId(id: string): QuickFixMatcher {
  const m = BUILTIN_QUICK_FIX_MATCHERS.find((x) => x.id === id)
  if (!m) throw new Error(`no matcher ${id}`)
  return m
}

describe("windowOutput", () => {
  const lines = ["l0", "l1", "l2", "l3", "l4"]
  it("anchors at the bottom", () => {
    expect(
      windowOutput(lines, { lineMatcher: /x/, anchor: "bottom", offset: 0, length: 2 })
    ).toEqual(["l3", "l4"])
  })
  it("applies the bottom offset", () => {
    expect(
      windowOutput(lines, { lineMatcher: /x/, anchor: "bottom", offset: 1, length: 2 })
    ).toEqual(["l2", "l3"])
  })
  it("anchors at the top", () => {
    expect(windowOutput(lines, { lineMatcher: /x/, anchor: "top", offset: 1, length: 2 })).toEqual([
      "l1",
      "l2",
    ])
  })
  it("returns [] for empty input or non-positive length", () => {
    expect(windowOutput([], { lineMatcher: /x/, anchor: "top", offset: 0, length: 4 })).toEqual([])
    expect(windowOutput(lines, { lineMatcher: /x/, anchor: "top", offset: 0, length: 0 })).toEqual(
      []
    )
  })
})

describe("gitSimilarCommand", () => {
  it("rewrites the subcommand to the suggested one", () => {
    const actions = run(byId("git-similar"), "git pul", [
      "git: 'pul' is not a git command. See 'git --help'.",
      "",
      "The most similar command is",
      "\tpull",
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      type: "run-command",
      command: "git pull",
      addNewLine: false,
    })
  })
  it("offers each of multiple suggestions, de-duplicated", () => {
    const actions = run(byId("git-similar"), "git chekout", [
      "git: 'chekout' is not a git command.",
      "The most similar commands are",
      "\tcheckout",
      "\tcheckout-index",
    ])
    expect(actions.map((a) => (a.type === "run-command" ? a.command : ""))).toEqual([
      "git checkout",
      "git checkout-index",
    ])
  })
})

describe("gitFastForwardPull", () => {
  it("offers git pull on a fast-forwardable branch", () => {
    const actions = run(byId("git-fast-forward-pull"), "git status", [
      "Your branch is behind 'origin/main' by 2 commits, and can be fast-forwarded.",
    ])
    expect(actions[0]).toMatchObject({ type: "run-command", command: "git pull", addNewLine: true })
  })
})

describe("gitTwoDashes", () => {
  it("doubles the dash on the offending argument", () => {
    const actions = run(byId("git-two-dashes"), "git commit -amend", [
      "error: did you mean `--amend` (with two dashes)?",
    ])
    expect(actions[0]).toMatchObject({ type: "run-command", command: "git commit --amend" })
  })
})

describe("freePort", () => {
  it("extracts the port from a node EADDRINUSE error", () => {
    const actions = run(byId("free-port"), "npm run dev", [
      "Error: listen EADDRINUSE: address already in use :::3000",
    ])
    expect(actions[0]).toMatchObject({ type: "kill-port", port: 3000, command: "npm run dev" })
  })
  it("extracts the port from an Unable to bind error", () => {
    const actions = run(byId("free-port"), "./server", ["Unable to bind 0.0.0.0:8080: in use"])
    expect(actions[0]).toMatchObject({ type: "kill-port", port: 8080 })
  })
  it("does not fire without a port", () => {
    expect(run(byId("free-port"), "ls", ["address already in use"])).toEqual([])
  })
})

describe("gitPushSetUpstream", () => {
  it("proposes the exact set-upstream command git printed", () => {
    const actions = run(byId("git-push-set-upstream"), "git push", [
      "fatal: The current branch feature/x has no upstream branch.",
      "To push the current branch and set the remote as upstream, use",
      "",
      "    git push --set-upstream origin feature/x",
    ])
    expect(actions[0]).toMatchObject({
      type: "run-command",
      command: "git push --set-upstream origin feature/x",
      addNewLine: true,
    })
  })
})

describe("gitCreatePr", () => {
  it("opens the GitHub PR url on a successful push", () => {
    const actions = run(byId("git-create-pr"), "git push", [
      "remote: Create a pull request for 'feature/x' on GitHub by visiting:",
      "remote:      https://github.com/owner/repo/pull/new/feature/x",
    ])
    expect(actions[0]).toMatchObject({
      type: "open-url",
      url: "https://github.com/owner/repo/pull/new/feature/x",
    })
  })
})

describe("pwshUnixCommandNotFoundError", () => {
  it("offers the alternative command and the install command", () => {
    const actions = run(byId("pwsh-unix-command-not-found"), "fop", [
      "Suggestion [cmd-not-found]: Command 'fop' not found, but can be installed with:",
      "command 'fop' from deb fop (universe)",
      "try: sudo apt install fop",
    ])
    const commands = actions.map((a) => (a.type === "run-command" ? a.command : ""))
    expect(commands).toContain("fop")
    expect(commands).toContain("sudo apt install fop")
  })
})

describe("pwshGeneralError", () => {
  it("splits comma-separated suggestions into actions", () => {
    const actions = run(byId("pwsh-general-error"), "gdi", [
      "Suggestion [General]: The most similar commands are: gci, gcm",
    ])
    expect(actions.map((a) => (a.type === "run-command" ? a.command : ""))).toEqual(["gci", "gcm"])
  })
  it("falls back to the whole suggestion when there is no colon list", () => {
    const actions = pwshGeneralError.getActions({
      commandLine: "gdi",
      outputLines: [],
      windowLines: [],
      outputMatch: "x".match(/(?<suggestion>x)/),
    })
    expect(actions[0]).toMatchObject({ type: "run-command", command: "x" })
  })
})

describe("getActions guards (defensive branches)", () => {
  it("return [] when the output match is absent", () => {
    expect(noMatch(gitSimilarCommand, "git pul")).toEqual([])
    expect(noMatch(gitTwoDashes, "git commit -amend")).toEqual([])
    expect(noMatch(gitPushSetUpstream, "git push")).toEqual([])
    expect(noMatch(gitCreatePr, "git push")).toEqual([])
    expect(noMatch(pwshGeneralError, "gdi")).toEqual([])
  })

  it("gitSimilar skips a suggestion that doesn't change the command", () => {
    // The command already uses the suggested subcommand → replacement is a
    // no-op → no action.
    const actions = run(byId("git-similar"), "git pull", ["The most similar command is", "\tpull"])
    expect(actions).toEqual([])
  })

  it("gitSimilar de-dupes repeated suggestions", () => {
    const actions = run(byId("git-similar"), "git chekout", [
      "The most similar commands are",
      "\tcheckout",
      "\tcheckout",
    ])
    expect(actions).toHaveLength(1)
  })

  it("gitTwoDashes returns [] when the replacement is a no-op", () => {
    // Output names an arg that isn't present as a single dash in the command.
    const actions = gitTwoDashes.getActions({
      commandLine: "git commit",
      outputLines: [],
      windowLines: [],
      outputMatch: "error: did you mean `--amend` (with two dashes)".match(
        /error: did you mean `--(?<dashes>[^`]+)` \(with two dashes\)/
      ),
    })
    expect(actions).toEqual([])
  })

  it("pwshUnixCommandNotFound ignores unrelated lines and de-dupes", () => {
    const actions = pwshUnixCommandNotFoundError.getActions({
      commandLine: "fop",
      outputLines: [],
      windowLines: ["random noise line", "try: install fop", "try: install fop"],
      outputMatch: null,
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ command: "install fop" })
  })
})
