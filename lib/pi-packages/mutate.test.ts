import { applyPiMutationToList, planPiMutation, setPiPackageAutoload, shellQuote } from "./mutate"

const AVAILABLE = { available: true, version: "0.84.1" }
const MISSING = { available: false }

describe("planPiMutation", () => {
  it("uses Pi's own CLI for a user-scope install", () => {
    expect(
      planPiMutation({ kind: "install", spec: "npm:a@1.0.0", scope: "user" }, AVAILABLE)
    ).toEqual({ strategy: "pi-cli", command: "pi install npm:a@1.0.0" })
  })

  /** `-l` is Pi's project flag; there is no `--global` counterpart. */
  it("adds -l for project scope and nothing for user scope", () => {
    expect(
      planPiMutation({ kind: "install", spec: "npm:a", scope: "project" }, AVAILABLE).command
    ).toBe("pi install npm:a -l")
    expect(
      planPiMutation({ kind: "install", spec: "npm:a", scope: "user" }, AVAILABLE).command
    ).toBe("pi install npm:a")
  })

  it("uses remove for uninstall", () => {
    expect(
      planPiMutation({ kind: "remove", spec: "npm:a", scope: "user" }, AVAILABLE).command
    ).toBe("pi remove npm:a")
  })

  /**
   * `pi update --extensions` skips exact-pinned specs, so a pinned package can
   * only be moved by naming it.
   */
  it("updates one package by name rather than using --extensions", () => {
    const command = planPiMutation(
      { kind: "update", spec: "npm:a@1.0.0", scope: "user" },
      AVAILABLE
    ).command
    expect(command).toBe("pi update --extension npm:a@1.0.0")
    expect(command).not.toContain("--extensions")
  })

  it("falls back to editing settings when Pi is not on PATH", () => {
    const plan = planPiMutation({ kind: "install", spec: "npm:a", scope: "user" }, MISSING)
    expect(plan.strategy).toBe("settings-edit")
    expect(plan.degradedReason).toBe("pi-unavailable")
    expect(plan.command).toBeUndefined()
  })
})

describe("shellQuote", () => {
  it("leaves an ordinary spec unquoted", () => {
    expect(shellQuote("npm:@aliou/pi-guardrails@0.17.0")).toBe("npm:@aliou/pi-guardrails@0.17.0")
  })

  it("quotes a path containing spaces", () => {
    expect(shellQuote("./my ext")).toBe("'./my ext'")
  })

  it("escapes an embedded single quote", () => {
    expect(shellQuote("./it's")).toBe(`'./it'\\''s'`)
  })

  it("quotes shell metacharacters", () => {
    expect(shellQuote("npm:a; rm -rf /")).toContain("'")
  })
})

describe("applyPiMutationToList", () => {
  it("appends a new package", () => {
    expect(
      applyPiMutationToList(["npm:a"], { kind: "install", spec: "npm:b", scope: "user" })
    ).toEqual(["npm:a", "npm:b"])
  })

  it("replaces in place when re-installing at a new pin, preserving order", () => {
    expect(
      applyPiMutationToList(["npm:a@1.0.0", "npm:b"], {
        kind: "install",
        spec: "npm:a@2.0.0",
        scope: "user",
      })
    ).toEqual(["npm:a@2.0.0", "npm:b"])
  })

  it("keeps an object entry's filters when bumping its pin", () => {
    expect(
      applyPiMutationToList([{ source: "npm:a@1.0.0", skills: [] }], {
        kind: "install",
        spec: "npm:a@2.0.0",
        scope: "user",
      })
    ).toEqual([{ source: "npm:a@2.0.0", skills: [] }])
  })

  it("removes by identity regardless of the installed pin", () => {
    expect(
      applyPiMutationToList(["npm:a@1.0.0", "npm:b"], {
        kind: "remove",
        spec: "npm:a@9.9.9",
        scope: "user",
      })
    ).toEqual(["npm:b"])
  })

  it("is a no-op removing something that is not installed", () => {
    expect(
      applyPiMutationToList(["npm:a"], { kind: "remove", spec: "npm:z", scope: "user" })
    ).toEqual(["npm:a"])
  })

  it("distinguishes local paths by their scope base dir", () => {
    const next = applyPiMutationToList(
      ["./ext"],
      {
        kind: "install",
        spec: "./ext",
        scope: "user",
      },
      "/home/u/.pi/agent"
    )
    expect(next).toHaveLength(1)
  })
})

describe("setPiPackageAutoload", () => {
  /** Pi has no `enabled` field — inert is `autoload: false`. */
  it("disables by writing autoload:false, matching what pi config writes", () => {
    expect(setPiPackageAutoload(["npm:a"], "npm:a", false)).toEqual([
      { source: "npm:a", autoload: false },
    ])
  })

  it("re-enables by removing the key rather than writing autoload:true", () => {
    expect(setPiPackageAutoload([{ source: "npm:a", autoload: false }], "npm:a", true)).toEqual([
      "npm:a",
    ])
  })

  it("keeps the object form when other filters are present", () => {
    expect(
      setPiPackageAutoload([{ source: "npm:a", autoload: false, skills: [] }], "npm:a", true)
    ).toEqual([{ source: "npm:a", skills: [] }])
  })

  it("matches by identity, so the pin does not have to be exact", () => {
    expect(setPiPackageAutoload(["npm:a@1.0.0"], "npm:a@2.0.0", false)).toEqual([
      { source: "npm:a@1.0.0", autoload: false },
    ])
  })

  it("leaves other packages untouched", () => {
    expect(setPiPackageAutoload(["npm:a", "npm:b"], "npm:a", false)).toEqual([
      { source: "npm:a", autoload: false },
      "npm:b",
    ])
  })
})
