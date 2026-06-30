import { evaluateQuickFixes } from "./evaluate"
import type { QuickFixMatcher } from "./matchers"

describe("evaluateQuickFixes", () => {
  it("returns [] for a blank command line", () => {
    expect(evaluateQuickFixes({ commandLine: "   ", outputLines: [], exitCode: 1 })).toEqual([])
  })

  it("fires gitPushSetUpstream on a failed push", () => {
    const actions = evaluateQuickFixes({
      commandLine: "git push",
      outputLines: ["    git push --set-upstream origin feature/x"],
      exitCode: 1,
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ command: "git push --set-upstream origin feature/x" })
  })

  it("does not fire error matchers when the command succeeded", () => {
    expect(
      evaluateQuickFixes({
        commandLine: "git push",
        outputLines: ["    git push --set-upstream origin feature/x"],
        exitCode: 0,
      })
    ).toEqual([])
  })

  it("never matches when the exit code is unknown (null)", () => {
    expect(
      evaluateQuickFixes({
        commandLine: "npm run dev",
        outputLines: ["Error: listen EADDRINUSE: address already in use :::3000"],
        exitCode: null,
      })
    ).toEqual([])
  })

  it("only runs matchers whose command-line gate passes", () => {
    // freePort (commandLineMatcher /.+/) fires; git matchers are gated out.
    const actions = evaluateQuickFixes({
      commandLine: "node server.js",
      outputLines: ["Error: listen EADDRINUSE: address already in use :::4000"],
      exitCode: 1,
    })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ type: "kill-port", port: 4000 })
  })

  it("de-duplicates actions sharing an id", () => {
    const dupe: QuickFixMatcher = {
      id: "dupe",
      commandLineMatcher: /.+/,
      commandExitResult: "error",
      getActions: () => [
        {
          type: "run-command",
          id: "same",
          labelKey: "runCommand",
          command: "x",
          addNewLine: false,
        },
      ],
    }
    const actions = evaluateQuickFixes({ commandLine: "anything", outputLines: [], exitCode: 1 }, [
      dupe,
      dupe,
    ])
    expect(actions).toHaveLength(1)
  })

  it("isolates a throwing matcher without breaking the rest", () => {
    const boom: QuickFixMatcher = {
      id: "boom",
      commandLineMatcher: /.+/,
      commandExitResult: "error",
      getActions: () => {
        throw new Error("nope")
      },
    }
    const ok: QuickFixMatcher = {
      id: "ok",
      commandLineMatcher: /.+/,
      commandExitResult: "error",
      getActions: () => [
        { type: "run-command", id: "ok", labelKey: "runCommand", command: "y", addNewLine: false },
      ],
    }
    const actions = evaluateQuickFixes({ commandLine: "z", outputLines: [], exitCode: 1 }, [
      boom,
      ok,
    ])
    expect(actions).toHaveLength(1)
    expect(actions[0].id).toBe("ok")
  })
})
