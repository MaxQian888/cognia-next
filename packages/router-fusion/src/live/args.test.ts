import { LIVE_SMOKE_SETTINGS_ENV, LIVE_SMOKE_USAGE, parseLiveSmokeArgs } from "./args"

describe("parseLiveSmokeArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseLiveSmokeArgs([])).toEqual({
      ok: true,
      args: { command: "dry_run", settingsPath: null, providers: null, outDir: null },
    })
  })

  it("maps --fake to a simulated run and --confirm to a live one", () => {
    expect(parseLiveSmokeArgs(["--fake"])).toMatchObject({ args: { command: "simulated" } })
    expect(parseLiveSmokeArgs(["--confirm"])).toMatchObject({ args: { command: "live" } })
  })

  it("never mixes a live and a simulated run", () => {
    expect(parseLiveSmokeArgs(["--confirm", "--fake"])).toEqual({
      ok: false,
      message: "--confirm and --fake cannot be combined: a run is either live or simulated",
    })
  })

  it("reads values as separate or joined arguments", () => {
    expect(
      parseLiveSmokeArgs(["--settings", "a.json", "--out=/tmp/x", "--providers", "openai"])
    ).toEqual({
      ok: true,
      args: {
        command: "dry_run",
        settingsPath: "a.json",
        providers: ["openai"],
        outDir: "/tmp/x",
      },
    })
  })

  it("splits, trims and de-duplicates the confirmed providers", () => {
    expect(parseLiveSmokeArgs(["--providers", " anthropic, openai,anthropic "])).toMatchObject({
      args: { providers: ["anthropic", "openai"] },
    })
    expect(parseLiveSmokeArgs(["--providers", ","])).toEqual({
      ok: false,
      message: "--providers names no provider",
    })
  })

  it("falls back to the settings path in the environment", () => {
    expect(parseLiveSmokeArgs([], { [LIVE_SMOKE_SETTINGS_ENV]: " /x/export.json " })).toMatchObject(
      {
        args: { settingsPath: "/x/export.json" },
      }
    )
    expect(
      parseLiveSmokeArgs(["--settings", "flag.json"], { [LIVE_SMOKE_SETTINGS_ENV]: "env.json" })
    ).toMatchObject({ args: { settingsPath: "flag.json" } })
  })

  it("refuses unknown options and options without a value", () => {
    expect(parseLiveSmokeArgs(["--yes"])).toEqual({ ok: false, message: "unknown option: --yes" })
    expect(parseLiveSmokeArgs(["--settings"])).toEqual({
      ok: false,
      message: "--settings needs a value",
    })
    expect(parseLiveSmokeArgs(["--out", "--fake"])).toEqual({
      ok: false,
      message: "--out needs a value",
    })
  })

  it("answers --help, which documents every option and where keys come from", () => {
    expect(parseLiveSmokeArgs(["-h"])).toMatchObject({ args: { command: "help" } })
    for (const option of ["--settings", "--providers", "--out", "--fake", "--confirm"]) {
      expect(LIVE_SMOKE_USAGE).toContain(option)
    }
    expect(LIVE_SMOKE_USAGE).toContain("COGNIA_LIVE_SMOKE_KEY_")
  })
})
