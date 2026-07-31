import { buildArgv, parseOutput, resolveCwd, CliTemplateError } from "./template"
import type { PluginCliArgvToken } from "@/types/plugin"

describe("buildArgv", () => {
  it("substitutes params as discrete argv elements", () => {
    const tokens: PluginCliArgvToken[] = [
      { literal: "--json" },
      { param: "pattern" },
      { param: "path", omitWhenEmpty: true },
    ]
    expect(buildArgv(tokens, { pattern: "needle", path: "src" })).toEqual([
      "--json",
      "needle",
      "src",
    ])
    expect(buildArgv(tokens, { pattern: "needle" })).toEqual(["--json", "needle"])
  })

  it.each([
    "; rm -rf /",
    "$(reboot)",
    "`id`",
    "a && b",
    "-rf /",
    "--flag=value; evil",
    'quote" breakout',
  ])("adversarial value %j stays a single argv element", (value) => {
    const argv = buildArgv([{ literal: "-e" }, { param: "pattern" }], { pattern: value })
    expect(argv).toEqual(["-e", value])
    expect(argv).toHaveLength(2)
  })

  it("expands arrays with eachPrefixedBy as element pairs", () => {
    const tokens: PluginCliArgvToken[] = [
      { param: "globs", eachPrefixedBy: "--glob", omitWhenEmpty: true },
    ]
    expect(buildArgv(tokens, { globs: ["*.ts", "ev il; rm"] })).toEqual([
      "--glob",
      "*.ts",
      "--glob",
      "ev il; rm",
    ])
    expect(buildArgv(tokens, { globs: [] })).toEqual([])
  })

  it("renders booleans as flags with a prefix and omits false", () => {
    const tokens: PluginCliArgvToken[] = [
      { param: "ignoreCase", eachPrefixedBy: "-i", omitWhenEmpty: true },
    ]
    expect(buildArgv(tokens, { ignoreCase: true })).toEqual(["-i"])
    expect(buildArgv(tokens, { ignoreCase: false })).toEqual([])
    // Without a prefix a true boolean renders literally.
    expect(buildArgv([{ param: "flag" }], { flag: true })).toEqual(["true"])
  })

  it("renders numbers and prefixes scalars", () => {
    expect(buildArgv([{ param: "max", eachPrefixedBy: "--max-count" }], { max: 5 })).toEqual([
      "--max-count",
      "5",
    ])
  })

  it("throws on missing required params and object values", () => {
    expect(() => buildArgv([{ param: "pattern" }], {})).toThrow(CliTemplateError)
    expect(() => buildArgv([{ param: "p" }], { p: { evil: 1 } })).toThrow(CliTemplateError)
    expect(() => buildArgv([{ param: "p" }], { p: [{ nested: 1 }] })).toThrow(CliTemplateError)
  })
})

describe("resolveCwd", () => {
  const ctx = { pluginPath: "C:/plugins/demo", workspaceRoot: "C:/work/repo" }

  it("resolves the four policy kinds", () => {
    expect(resolveCwd(undefined, {}, ctx)).toBeUndefined()
    expect(resolveCwd({ kind: "none" }, {}, ctx)).toBeUndefined()
    expect(resolveCwd({ kind: "plugin-dir" }, {}, ctx)).toBe("C:/plugins/demo")
    expect(resolveCwd({ kind: "workspace" }, {}, ctx)).toBe("C:/work/repo")
    expect(resolveCwd({ kind: "param", param: "dir" }, { dir: "src/app" }, ctx)).toBe(
      "C:/work/repo/src/app"
    )
  })

  it("accepts absolute param paths inside the workspace, rejects outside", () => {
    expect(resolveCwd({ kind: "param", param: "dir" }, { dir: "C:/work/repo/sub" }, ctx)).toBe(
      "C:/work/repo/sub"
    )
    expect(() => resolveCwd({ kind: "param", param: "dir" }, { dir: "C:/elsewhere" }, ctx)).toThrow(
      CliTemplateError
    )
  })

  it("rejects traversal, empty values, and workspace-less contexts", () => {
    expect(() => resolveCwd({ kind: "param", param: "dir" }, { dir: "a/../../b" }, ctx)).toThrow(
      CliTemplateError
    )
    expect(() => resolveCwd({ kind: "param", param: "dir" }, { dir: "" }, ctx)).toThrow(
      CliTemplateError
    )
    const noWorkspace = { pluginPath: "C:/p", workspaceRoot: undefined }
    expect(() => resolveCwd({ kind: "workspace" }, {}, noWorkspace)).toThrow(CliTemplateError)
    expect(() => resolveCwd({ kind: "param", param: "dir" }, { dir: "x" }, noWorkspace)).toThrow(
      CliTemplateError
    )
  })
})

describe("parseOutput", () => {
  it("text trims trailing whitespace only", () => {
    expect(parseOutput("hello \n", "text")).toBe("hello")
    expect(parseOutput("  keep-leading\n", undefined)).toBe("  keep-leading")
  })

  it("lines splits and drops empties", () => {
    expect(parseOutput("a\r\nb\n\nc\n", "lines")).toEqual(["a", "b", "c"])
  })

  it("json parses or throws a typed error", () => {
    expect(parseOutput('{"ok":true}', "json")).toEqual({ ok: true })
    expect(() => parseOutput("not json", "json")).toThrow(CliTemplateError)
  })
})
