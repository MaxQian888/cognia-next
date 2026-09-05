import { parseArgv } from "./args"
import {
  DEFAULT_TIMEOUT_MS,
  emitResult,
  parseDuration,
  renderTable,
  renderValue,
  resolveOutputOptions,
  type OutputOptions,
} from "./format"
import type { OutputSink } from "./output"

function sink(): OutputSink & { stdout: string; stderr: string[] } {
  const captured = {
    stdout: "",
    stderr: [] as string[],
    write(text: string) {
      captured.stdout += text
    },
    error(text: string) {
      captured.stderr.push(text)
    },
    json(value: unknown) {
      captured.stdout += `${JSON.stringify(value)}\n`
    },
  }
  return captured
}

function options(overrides: Partial<OutputOptions> = {}): OutputOptions {
  return { format: "raw", debug: false, timeoutMs: DEFAULT_TIMEOUT_MS, ...overrides }
}

describe("parseDuration", () => {
  it("reads the suffixed forms", () => {
    expect(parseDuration("500ms")).toBe(500)
    expect(parseDuration("30s")).toBe(30_000)
    expect(parseDuration("2m")).toBe(120_000)
    expect(parseDuration("1h")).toBe(3_600_000)
  })

  it("reads a bare number as seconds", () => {
    expect(parseDuration("10")).toBe(10_000)
  })

  it("refuses zero, negatives, and nonsense rather than defaulting", () => {
    expect(parseDuration("0")).toBeUndefined()
    expect(parseDuration("-5s")).toBeUndefined()
    expect(parseDuration("soon")).toBeUndefined()
    expect(parseDuration("30 s")).toBeUndefined()
  })
})

describe("resolveOutputOptions", () => {
  it("defaults to pretty on a bare invocation", () => {
    const resolved = resolveOutputOptions(parseArgv(["api", "list"]), {})
    expect(resolved).toMatchObject({ format: "pretty", debug: false })
  })

  it("defaults to raw when -o names a directory", () => {
    const resolved = resolveOutputOptions(parseArgv(["api", "list", "--output", "./out"]), {})
    expect(resolved).toMatchObject({ format: "raw", outputDir: "./out" })
  })

  it("lets an explicit --format beat the -o default", () => {
    const resolved = resolveOutputOptions(
      parseArgv(["api", "list", "--output", "./out", "--format", "pretty"]),
      {}
    )
    expect(resolved).toMatchObject({ format: "pretty", outputDir: "./out" })
  })

  it("treats --json as --format raw so older scripts keep working", () => {
    const resolved = resolveOutputOptions(parseArgv(["api", "list", "--json"]), {})
    expect(resolved).toMatchObject({ format: "raw" })
  })

  it("refuses an unknown format with a fix naming the valid ones", () => {
    const resolved = resolveOutputOptions(parseArgv(["api", "list", "--format", "yaml"]), {})
    expect(resolved).toHaveProperty("error")
    expect((resolved as { fix: string }).fix).toContain("pretty")
  })

  it("reads --timeout and falls back to the default when absent", () => {
    expect(resolveOutputOptions(parseArgv(["api", "list", "--timeout", "5s"]), {})).toMatchObject({
      timeoutMs: 5000,
    })
    expect(resolveOutputOptions(parseArgv(["api", "list"]), {})).toMatchObject({
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
  })

  it("takes the timeout from the environment when no flag is given", () => {
    expect(
      resolveOutputOptions(parseArgv(["api", "list"]), { COGNIA_TIMEOUT: "2m" })
    ).toMatchObject({ timeoutMs: 120_000 })
  })

  it("refuses an unreadable timeout instead of silently using the default", () => {
    const resolved = resolveOutputOptions(parseArgv(["api", "list", "--timeout", "soon"]), {})
    expect(resolved).toHaveProperty("error")
    expect((resolved as { fix: string }).fix).toContain("30s")
  })
})

describe("renderValue", () => {
  it("writes one compact line for raw", () => {
    expect(renderValue({ a: 1, b: [2] }, "raw")).toBe('{"a":1,"b":[2]}\n')
  })

  it("indents for json", () => {
    expect(renderValue({ a: 1 }, "json")).toBe('{\n  "a": 1\n}\n')
  })

  it("renders an array of objects as an aligned table", () => {
    const text = renderValue(
      [
        { name: "plugin_list", risk: "low" },
        { name: "plugin_uninstall", risk: "high" },
      ],
      "pretty"
    )
    const lines = text.trimEnd().split("\n")
    expect(lines[0]).toBe("name              risk")
    expect(lines[1]).toBe("----------------  ----")
    expect(lines[2]).toBe("plugin_list       low")
  })

  it("says so when a pretty list is empty rather than printing nothing", () => {
    expect(renderValue([], "pretty")).toBe("(no results)\n")
  })

  it("renders an object as an aligned key block", () => {
    expect(renderValue({ name: "x", risk: "low" }, "pretty")).toBe("name  x\nrisk  low\n")
  })

  it("flattens a scalar array onto one line", () => {
    expect(renderValue({ wires: ["internal", "http"] }, "pretty")).toBe("wires  internal, http\n")
  })

  it("nests an object under its key", () => {
    expect(renderValue({ meta: { a: 1 } }, "pretty")).toBe("meta:\n  a  1\n")
  })

  it("renders a nested array of objects as an indented table", () => {
    const text = renderValue({ flags: [{ flag: "id", type: "string" }] }, "pretty")
    expect(text).toContain("flags:")
    expect(text).toContain("  flag  type")
  })

  it("prints a bare scalar without quoting it", () => {
    expect(renderValue("ready", "pretty")).toBe("ready\n")
    expect(renderValue(true, "pretty")).toBe("true\n")
  })

  it("marks an empty object rather than printing a blank line", () => {
    expect(renderValue({}, "pretty")).toBe("(empty)\n")
  })
})

describe("renderTable", () => {
  it("unions the columns across rows with gaps left blank", () => {
    const text = renderTable([{ a: 1 }, { b: 2 }])
    const lines = text.split("\n")
    expect(lines[0]).toBe("a  b")
    expect(lines[2]).toBe("1")
    expect(lines[3]).toBe("   2")
  })
})

describe("emitResult", () => {
  it("writes to stdout when no output directory is set", () => {
    const out = sink()
    expect(emitResult(out, { a: 1 }, options(), "result")).toBeUndefined()
    expect(out.stdout).toBe('{"a":1}\n')
  })

  it("writes a .json file for a machine format", () => {
    const out = sink()
    const written: Array<[string, string]> = []
    const target = emitResult(out, { a: 1 }, options({ outputDir: "/tmp/out" }), "plugin_list", {
      mkdir: () => undefined,
      writeFile: (file, contents) => written.push([file, contents]),
      resolve: (...segments) => segments.join("/"),
    })
    expect(target).toBe("/tmp/out/plugin_list.json")
    expect(written).toEqual([["/tmp/out/plugin_list.json", '{"a":1}\n']])
    expect(out.stdout).toBe("")
  })

  it("writes a .txt file when the operator asked for the rendered form", () => {
    const out = sink()
    const written: Array<[string, string]> = []
    const target = emitResult(
      out,
      { a: 1 },
      options({ format: "pretty", outputDir: "/tmp/out" }),
      "plugin_list",
      {
        mkdir: () => undefined,
        writeFile: (file, contents) => written.push([file, contents]),
        resolve: (...segments) => segments.join("/"),
      }
    )
    expect(target).toBe("/tmp/out/plugin_list.txt")
    expect(written[0][1]).toBe("a  1\n")
  })

  it("creates the output directory before writing into it", () => {
    const created: string[] = []
    emitResult(sink(), { a: 1 }, options({ outputDir: "/tmp/deep/out" }), "x", {
      mkdir: (dir) => created.push(dir),
      writeFile: () => undefined,
      resolve: (...segments) => segments.join("/"),
    })
    expect(created).toEqual(["/tmp/deep/out"])
  })
})
