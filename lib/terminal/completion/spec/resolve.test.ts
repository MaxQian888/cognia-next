import { resolveSpec } from "./resolve"
import type { CliSpec } from "./types"

const spec: CliSpec = {
  name: "tool",
  options: [
    { name: "--global", aliases: ["-g"], description: "Global flag" },
    { name: "--config", aliases: ["-c"], description: "Config file", takesValue: true },
  ],
  subcommands: [
    {
      name: "remote",
      description: "Manage remotes",
      options: [{ name: "--verbose", aliases: ["-v"], description: "Verbose" }],
      subcommands: [
        { name: "add", description: "Add a remote" },
        { name: "remove", aliases: ["rm"], description: "Remove a remote" },
      ],
    },
    {
      name: "commit",
      description: "Record changes",
      options: [
        { name: "--message", aliases: ["-m"], description: "Message", takesValue: true },
        { name: "--amend", description: "Amend" },
      ],
    },
    { name: "status", description: "Show status" },
  ],
}

describe("resolveSpec", () => {
  it("offers top-level subcommands for an empty token", () => {
    const out = resolveSpec(spec, [], "")
    expect(out.map((c) => c.name)).toEqual(["remote", "commit", "status"])
    expect(out[0].kind).toBe("subcommand")
  })

  it("prefix-filters case-insensitively and keeps canonical casing", () => {
    const out = resolveSpec(spec, [], "RE")
    expect(out.map((c) => c.name)).toEqual(["remote"])
  })

  it("descends through subcommands, including aliases", () => {
    expect(resolveSpec(spec, ["remote"], "").map((c) => c.name)).toEqual(["add", "remove"])
    expect(resolveSpec(spec, ["remote"], "r").map((c) => c.name)).toEqual(["remove"])
  })

  it("offers options for a dash-prefixed token, scoped + global", () => {
    const out = resolveSpec(spec, ["commit"], "--")
    expect(out.map((c) => c.name)).toEqual(
      expect.arrayContaining(["--message", "--amend", "--global", "--config"])
    )
    expect(out.every((c) => c.kind === "option")).toBe(true)
  })

  it("skips option tokens while descending", () => {
    const out = resolveSpec(spec, ["--global", "remote"], "")
    expect(out.map((c) => c.name)).toEqual(["add", "remove"])
  })

  it("swallows the value token of a takesValue option", () => {
    // `--config myfile remote` — "myfile" must not be treated as a subcommand.
    const out = resolveSpec(spec, ["--config", "myfile", "remote"], "")
    expect(out.map((c) => c.name)).toEqual(["add", "remove"])
  })

  it("does not swallow a value for the --opt=value form", () => {
    const out = resolveSpec(spec, ["--config=myfile", "remote"], "")
    expect(out.map((c) => c.name)).toEqual(["add", "remove"])
  })

  it("returns nothing past an unknown positional", () => {
    expect(resolveSpec(spec, ["status", "some-file"], "")).toEqual([])
    expect(resolveSpec(spec, ["unknown-sub"], "")).toEqual([])
  })

  it("excludes the exact already-typed candidate", () => {
    expect(resolveSpec(spec, [], "status")).toEqual([])
  })

  it("dedupes option names across scopes", () => {
    const dup: CliSpec = {
      name: "t",
      options: [{ name: "--force" }],
      subcommands: [{ name: "x", options: [{ name: "--force", description: "scoped" }] }],
    }
    const out = resolveSpec(dup, ["x"], "--f")
    expect(out).toHaveLength(1)
    expect(out[0].description).toBe("scoped") // node-scoped beats global
  })
})
