import { resolve } from "node:path"

import {
  applyWorkbenchEnv,
  joinStateDir,
  resolveWorkbenchEnv,
  STATE_DIR_KEY,
  WORKSPACE_DIR_KEY,
  WorkbenchEnvError,
} from "./env-binding"

const WS = resolve("/work/paper-ws")

/** What Cognia forwards for the manifest's hostedSession.env with default config. */
const FORWARDED = {
  COGNIA_PIPKG_LATEXWB_PROJECT: "demo",
  COGNIA_PIPKG_LATEXWB_PROTECTION: "strict",
  COGNIA_PIPKG_LATEXWB_WORKSPACE: "local",
  [STATE_DIR_KEY]: ".latexwb",
  [WORKSPACE_DIR_KEY]: WS,
}

describe("resolveWorkbenchEnv", () => {
  it("maps COGNIA_PIPKG_LATEXWB_* onto LATEXWB_* and joins the state dir onto the workspace", () => {
    expect(resolveWorkbenchEnv(FORWARDED)).toEqual({
      assignments: {
        LATEXWB_PROJECT: "demo",
        LATEXWB_PROTECTION: "strict",
        LATEXWB_WORKSPACE: "local",
        LATEXWB_STATE: resolve(WS, ".latexwb"),
      },
      skipped: [],
    })
  })

  it("never overrides a binding the host already set", () => {
    const binding = resolveWorkbenchEnv({
      ...FORWARDED,
      LATEXWB_PROJECT: "chosen-by-hand",
      LATEXWB_STATE: "/elsewhere/.latexwb",
    })
    expect(binding.assignments).toEqual({
      LATEXWB_PROTECTION: "strict",
      LATEXWB_WORKSPACE: "local",
    })
    expect(binding.skipped).toEqual(
      expect.arrayContaining([
        { target: "LATEXWB_PROJECT", reason: "already-set" },
        { target: "LATEXWB_STATE", reason: "already-set" },
      ])
    )
  })

  it("leaves the session unbound when the plugin's default project is empty", () => {
    // An empty `project` config must not bind the extension to the empty id —
    // unbound is the upstream's inert mode.
    const binding = resolveWorkbenchEnv({ ...FORWARDED, COGNIA_PIPKG_LATEXWB_PROJECT: "" })
    expect(binding.assignments).not.toHaveProperty("LATEXWB_PROJECT")
    expect(binding.skipped).toContainEqual({ target: "LATEXWB_PROJECT", reason: "empty" })
  })

  it("prefers an explicitly forwarded LATEXWB_STATE over the join", () => {
    const binding = resolveWorkbenchEnv({ ...FORWARDED, COGNIA_PIPKG_LATEXWB_STATE: "/abs/state" })
    expect(binding.assignments.LATEXWB_STATE).toBe("/abs/state")
  })

  it("ignores names that are not workbench variables or not upper-case", () => {
    const binding = resolveWorkbenchEnv({
      COGNIA_PIPKG_OTHER_PLUGIN_TOKEN: "x",
      COGNIA_PIPKG_LATEXWB_lower: "x",
      COGNIA_PIPKG_LATEXWB_: "x",
      LATEXWB_PRINCIPAL: "op",
      PATH: "/bin",
    })
    expect(binding).toEqual({ assignments: {}, skipped: [] })
  })

  it("records an empty forwarded state dir instead of binding it", () => {
    const binding = resolveWorkbenchEnv({ [STATE_DIR_KEY]: "", [WORKSPACE_DIR_KEY]: WS })
    expect(binding.assignments).toEqual({})
    expect(binding.skipped).toEqual([{ target: "LATEXWB_STATE", reason: "empty" }])
  })

  it("refuses a state dir without a workspace to place it in", () => {
    expect(() => resolveWorkbenchEnv({ [STATE_DIR_KEY]: ".latexwb" })).toThrow(WorkbenchEnvError)
  })

  it("does not modify its input", () => {
    const env = { ...FORWARDED }
    resolveWorkbenchEnv(env)
    expect(env).toEqual(FORWARDED)
  })
})

describe("joinStateDir", () => {
  it("resolves nested workspace-relative directories", () => {
    expect(joinStateDir(WS, "build/.latexwb")).toBe(resolve(WS, "build/.latexwb"))
    expect(joinStateDir(WS, "./state")).toBe(resolve(WS, "state"))
  })

  it.each([
    ["an absolute path", "/tmp/state"],
    ["a drive path", "C:\\state"],
    ["a parent escape", "../outside"],
    ["a nested escape", "a/../../outside"],
    ["the workspace root itself", "."],
  ])("refuses %s", (_label, stateDir) => {
    expect(() => joinStateDir(WS, stateDir)).toThrow(WorkbenchEnvError)
  })

  it("refuses a relative workspace dir", () => {
    expect(() => joinStateDir("relative/ws", ".latexwb")).toThrow(/absolute workspace path/)
  })
})

describe("applyWorkbenchEnv", () => {
  it("writes the assignments into the given environment and returns the binding", () => {
    const env: Record<string, string | undefined> = { ...FORWARDED }
    const binding = applyWorkbenchEnv(env)
    expect(env.LATEXWB_PROJECT).toBe("demo")
    expect(env.LATEXWB_STATE).toBe(resolve(WS, ".latexwb"))
    expect(binding.assignments.LATEXWB_WORKSPACE).toBe("local")
  })
})
