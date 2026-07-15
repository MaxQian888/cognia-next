import { inferLanguageFromPath, resolveToolOutputRender } from "./tool-output-format"

const CAT_CPP = [
  "// Linux sandbox backend",
  "#include <fcntl.h>",
  "#include <sys/stat.h>",
  "",
  "namespace cppjudge {",
  "    int fd = open(path, O_RDONLY);",
  "}",
].join("\n")

describe("inferLanguageFromPath", () => {
  it.each([
    ["src/sandbox_linux.cpp", "cpp"],
    ["a/b/main.rs", "rust"],
    ["Component.tsx", "tsx"],
    ["notes.md", "markdown"],
    ["deep.name.with.dots.py", "python"],
    ["/abs/path/x.h", "c"],
  ])("maps %s → %s", (path, lang) => {
    expect(inferLanguageFromPath(path)).toBe(lang)
  })

  it.each([[undefined], [""], ["Makefile"], ["archive.zzz"]])(
    "returns undefined for %s",
    (path) => {
      expect(inferLanguageFromPath(path)).toBeUndefined()
    }
  )
})

describe("resolveToolOutputRender — terminal tools", () => {
  const bash = (output: string, command?: string) =>
    resolveToolOutputRender(output, "tool-Bash", command === undefined ? undefined : { command })

  it.each(["tool-Bash", "tool-bash", "tool-mcp__cognia-tools__bash"])(
    "renders %s output as code, never Markdown",
    (toolType) => {
      expect(
        resolveToolOutputRender("total 8\ndrwxr-xr-x  2 me", toolType, { command: "ls -la" })
      ).toEqual({
        kind: "code",
      })
    }
  )

  it("highlights `cat file.cpp` output as cpp", () => {
    expect(bash(CAT_CPP, "cat /Users/me/src/sandbox_linux.cpp")).toEqual({
      kind: "code",
      language: "cpp",
    })
  })

  it.each([
    ["head -80 src/main.rs", "rust"],
    ["tail -n 20 app/server.py", "python"],
    ["bat components/Thing.tsx", "tsx"],
    ["less docs/readme.md", "markdown"],
    ["type C:\\src\\prog.cs", "csharp"],
    ["Get-Content .\\build.ps1", undefined], // ps1 is not in the ext map
    ["gc lib/util.ts", "typescript"],
  ])("infers the language from `%s`", (command, lang) => {
    const result = bash("...", command)
    expect(result).toEqual(lang ? { kind: "code", language: lang } : { kind: "code" })
  })

  it("handles the real-world piped + chained command from the bug report", () => {
    const command =
      'cat /Users/me/src/sandbox_linux.cpp | head -80 && echo "..." && cat /Users/me/src/sandbox_util.cpp'
    expect(bash(CAT_CPP, command)).toEqual({ kind: "code", language: "cpp" })
  })

  it("stays unhighlighted when chained dumps disagree on language", () => {
    expect(bash("...", "cat a.cpp && cat b.ts")).toEqual({ kind: "code" })
  })

  it("ignores paths that are not being dumped (echo must not trigger a language)", () => {
    expect(bash("...", 'echo "see main.rs for details"')).toEqual({ kind: "code" })
  })

  it("does not treat a numeric flag argument as a filename", () => {
    expect(bash("...", "head -n 80 src/main.rs")).toEqual({ kind: "code", language: "rust" })
  })

  it("strips quotes around a path containing spaces", () => {
    expect(bash("...", 'cat "my notes.md"')).toEqual({ kind: "code", language: "markdown" })
  })

  it("falls back to json highlighting when a command emits JSON with no file to key off", () => {
    expect(bash('{\n  "ok": true\n}', "curl -s https://api.example.com/x")).toEqual({
      kind: "code",
      language: "json",
    })
  })

  it("prefers the file extension over the JSON sniff", () => {
    expect(bash('{\n  "ok": true\n}', "cat tsconfig.json")).toEqual({
      kind: "code",
      language: "json",
    })
  })

  it("renders plain output with no language when nothing is inferable", () => {
    expect(bash("total 8\ndrwxr-xr-x", "ls -la")).toEqual({ kind: "code" })
  })

  it("survives a missing/odd input shape", () => {
    expect(resolveToolOutputRender("x", "tool-Bash", undefined)).toEqual({ kind: "code" })
    expect(resolveToolOutputRender("x", "tool-Bash", { command: 42 })).toEqual({ kind: "code" })
  })
})

describe("resolveToolOutputRender — non-terminal tools keep existing behaviour", () => {
  it("treats prose output as Markdown", () => {
    expect(resolveToolOutputRender("**Found** 3 results", "tool-WebFetch")).toEqual({
      kind: "markdown",
    })
  })

  it.each(['{"a":1}', "[1, 2, 3]"])("syntax-highlights the JSON result %s", (output) => {
    expect(resolveToolOutputRender(output, "tool-WebFetch")).toEqual({
      kind: "code",
      language: "json",
    })
  })

  it("falls back to Markdown with no tool type", () => {
    expect(resolveToolOutputRender("hello", undefined)).toEqual({ kind: "markdown" })
  })

  it("does not mistake a brace-wrapped snippet for JSON", () => {
    expect(resolveToolOutputRender("{ not json ]", "tool-WebFetch")).toEqual({ kind: "markdown" })
  })

  it("treats an empty string as Markdown", () => {
    expect(resolveToolOutputRender("", "tool-WebFetch")).toEqual({ kind: "markdown" })
  })

  it("does not fold an unrelated tool that merely ends in `bash`", () => {
    expect(resolveToolOutputRender("x", "tool-rebash")).toEqual({ kind: "markdown" })
  })
})
