import { EventEmitter } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import { parseArgv } from "./args"
import { runStrixScanner, securityCommand, type ScannerOutcome } from "./security-command"
import type { OutputSink } from "./output"

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const objects: unknown[] = []
  const out: OutputSink = {
    write: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
    json: (obj) => objects.push(obj),
  }
  return { out, stdout, stderr, objects, all: () => stdout.join("") + stderr.join("\n") }
}

const CRITICAL = JSON.stringify([
  {
    rule_id: "sqli",
    title: "SQL injection",
    severity: "critical",
    code_locations: [{ file: "a.ts" }],
  },
])
const LOW = JSON.stringify([
  { rule_id: "csp", title: "Missing CSP", severity: "low", code_locations: [{ file: "b.ts" }] },
])

function run(argv: string[], deps: Parameters<typeof securityCommand>[1] = {}) {
  return securityCommand(parseArgv(argv), deps)
}

describe("security report", () => {
  it("exits 0 and says so when nothing meets the threshold", async () => {
    const io = sink()
    const code = await run(["security", "report", "--input", "r.json", "--fail-on", "high"], {
      out: io.out,
      readFile: async () => LOW,
    })
    expect(code).toBe(0)
    expect(io.all()).toMatch(/clean at or above high/)
  })

  it("exits 2 and names the blocking findings", async () => {
    const io = sink()
    const code = await run(["security", "report", "--input", "r.json", "--fail-on", "high"], {
      out: io.out,
      readFile: async () => CRITICAL,
    })
    expect(code).toBe(2)
    expect(io.stderr.join("\n")).toMatch(/\[critical\] sqli — SQL injection/)
  })

  it("is report-only without --fail-on, and says the exit code is not a gate", async () => {
    const io = sink()
    const code = await run(["security", "report", "--input", "r.json"], {
      out: io.out,
      readFile: async () => CRITICAL,
    })
    expect(code).toBe(0)
    expect(io.stdout.join("")).toMatch(/report only: no --fail-on/)
  })

  it("exits 1 for an unparseable artifact and refuses to call it clean", async () => {
    const io = sink()
    const code = await run(["security", "report", "--input", "r.json", "--fail-on", "critical"], {
      out: io.out,
      readFile: async () => "{not json",
    })
    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/INCONCLUSIVE/)
    expect(io.stderr.join("\n")).toMatch(/NOT a clean result/)
  })

  it("exits 1 for a payload that is valid JSON but not a finding list", async () => {
    const io = sink()
    const code = await run(["security", "report", "--input", "r.json"], {
      out: io.out,
      readFile: async () => JSON.stringify({ totallyUnexpected: true }),
    })
    expect(code).toBe(1)
  })

  it("exits 1 when the input file cannot be read", async () => {
    const io = sink()
    const code = await run(["security", "report", "--input", "missing.json"], {
      out: io.out,
      readFile: async () => {
        throw new Error("ENOENT")
      },
    })
    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/could not read missing.json/)
  })

  it("requires --input", async () => {
    const io = sink()
    expect(await run(["security", "report"], { out: io.out })).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/requires --input/)
  })

  it("rejects an unknown --fail-on severity instead of ignoring it", async () => {
    // Silently ignoring it would leave a pipeline believing it was gated.
    const io = sink()
    const code = await run(["security", "report", "--input", "r.json", "--fail-on", "wat"], {
      out: io.out,
      readFile: async () => CRITICAL,
    })
    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/--fail-on must be one of/)
  })

  it("writes a SARIF log when asked", async () => {
    const io = sink()
    const written: Record<string, string> = {}
    await run(["security", "report", "--input", "r.json", "--sarif", "out.sarif"], {
      out: io.out,
      readFile: async () => CRITICAL,
      writeFile: async (path, contents) => {
        written[path] = contents
      },
    })
    const log = JSON.parse(written["out.sarif"])
    expect(log.version).toBe("2.1.0")
    expect(log.runs[0].results).toHaveLength(1)
    expect(log.runs[0].invocations[0].executionSuccessful).toBe(true)
  })

  it("still writes a SARIF log for an inconclusive run, marked failed", async () => {
    // Skipping the write would leave a previous log in place and read as a
    // successful scan.
    const io = sink()
    const written: Record<string, string> = {}
    const code = await run(["security", "report", "--input", "r.json", "--sarif", "out.sarif"], {
      out: io.out,
      readFile: async () => "{nope",
      writeFile: async (path, contents) => {
        written[path] = contents
      },
    })
    expect(code).toBe(1)
    expect(JSON.parse(written["out.sarif"]).runs[0].invocations[0].executionSuccessful).toBe(false)
  })

  it("gates on new findings only, against a baseline", async () => {
    const io = sink()
    // Round-trip: the baseline is a SARIF log this command itself produced.
    const written: Record<string, string> = {}
    await run(["security", "report", "--input", "r.json", "--sarif", "base.sarif"], {
      out: io.out,
      readFile: async () => CRITICAL,
      writeFile: async (path, contents) => {
        written[path] = contents
      },
    })
    const second = sink()
    const code = await run(
      [
        "security",
        "report",
        "--input",
        "r.json",
        "--fail-on",
        "high",
        "--only-new",
        "--baseline",
        "base.sarif",
      ],
      {
        out: second.out,
        readFile: async (path) => (path === "base.sarif" ? written["base.sarif"] : CRITICAL),
      }
    )
    expect(code).toBe(0)
  })

  it("treats every finding as new when the baseline cannot be read", async () => {
    // Over-reporting is the safe direction; a typo'd path must not pass a gate.
    const io = sink()
    const code = await run(
      [
        "security",
        "report",
        "--input",
        "r.json",
        "--fail-on",
        "high",
        "--only-new",
        "--baseline",
        "gone.sarif",
      ],
      {
        out: io.out,
        readFile: async (path) => {
          if (path === "gone.sarif") throw new Error("ENOENT")
          return CRITICAL
        },
      }
    )
    expect(code).toBe(2)
    expect(io.stderr.join("\n")).toMatch(/treating every finding as new/)
  })

  it("warns when --only-new is used with no baseline at all", async () => {
    const io = sink()
    const code = await run(
      ["security", "report", "--input", "r.json", "--fail-on", "high", "--only-new"],
      { out: io.out, readFile: async () => CRITICAL }
    )
    expect(code).toBe(2)
    expect(io.stderr.join("\n")).toMatch(/--only-new was given without --baseline/)
  })

  it("emits a machine-readable result under --json", async () => {
    const io = sink()
    const code = await run(
      ["security", "report", "--input", "r.json", "--fail-on", "high", "--json"],
      { out: io.out, readFile: async () => CRITICAL }
    )
    expect(code).toBe(2)
    expect(io.objects[0]).toMatchObject({
      exitCode: 2,
      verdict: "threshold-met",
      counts: { critical: 1 },
      blocking: [{ ruleId: "sqli", severity: "critical" }],
    })
  })

  it("reports an inconclusive run in --json too", async () => {
    const io = sink()
    await run(["security", "report", "--input", "r.json", "--json"], {
      out: io.out,
      readFile: async () => "{nope",
    })
    expect(io.objects[0]).toMatchObject({ exitCode: 1, verdict: "inconclusive" })
  })
})

describe("security scan", () => {
  const env = { LLM_API_KEY: "sk-test" }

  it("refuses to run without an explicit authorization assertion", async () => {
    const io = sink()
    const runScanner = jest.fn()
    const code = await run(["security", "scan", "--target", "https://x"], {
      out: io.out,
      env,
      runScanner,
    })
    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/requires --authorized/)
    expect(runScanner).not.toHaveBeenCalled()
  })

  it("refuses without credentials in the environment, and says keys are not flags", async () => {
    const io = sink()
    const runScanner = jest.fn()
    const code = await run(["security", "scan", "--target", "https://x", "--authorized"], {
      out: io.out,
      env: {},
      runScanner,
    })
    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/never accepted as flags|never accepted as a flag|argv/)
    expect(runScanner).not.toHaveBeenCalled()
  })

  it("requires a target", async () => {
    const io = sink()
    expect(await run(["security", "scan", "--authorized"], { out: io.out, env })).toBe(1)
  })

  it("runs the scanner and gates on its artifact", async () => {
    const io = sink()
    const outcome: ScannerOutcome = { exitCode: 0, artifact: CRITICAL }
    const code = await run(
      ["security", "scan", "--target", "https://x", "--authorized", "--fail-on", "high"],
      { out: io.out, env, runScanner: async () => outcome }
    )
    expect(code).toBe(2)
  })

  it("treats a scanner that produced no artifact as a clean scan", async () => {
    const io = sink()
    const code = await run(
      ["security", "scan", "--target", "https://x", "--authorized", "--fail-on", "info"],
      { out: io.out, env, runScanner: async () => ({ exitCode: 0, artifact: null }) }
    )
    expect(code).toBe(0)
  })

  it("treats an unparseable scanner artifact as inconclusive, not clean", async () => {
    const io = sink()
    const code = await run(
      ["security", "scan", "--target", "https://x", "--authorized", "--fail-on", "info"],
      { out: io.out, env, runScanner: async () => ({ exitCode: 0, artifact: "{broken" }) }
    )
    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/INCONCLUSIVE/)
  })

  it("treats scanner exit 1 without an artifact as inconclusive, not clean", async () => {
    const io = sink()
    const code = await run(
      ["security", "scan", "--target", "https://x", "--authorized", "--fail-on", "info"],
      { out: io.out, env, runScanner: async () => ({ exitCode: 1, artifact: null }) }
    )

    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/INCONCLUSIVE/)
  })

  it("exits 1 when the scanner could not be started", async () => {
    const io = sink()
    const code = await run(["security", "scan", "--target", "https://x", "--authorized"], {
      out: io.out,
      env,
      runScanner: async () => ({ exitCode: 1, artifact: null, error: "strix not found" }),
    })
    expect(code).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/strix not found/)
  })

  it("accepts STRIX_LLM_API_KEY as the credential too", async () => {
    const io = sink()
    const runScanner = jest.fn(async () => ({ exitCode: 0, artifact: null }))
    const code = await run(["security", "scan", "--target", "https://x", "--authorized"], {
      out: io.out,
      env: { STRIX_LLM_API_KEY: "sk-other" },
      runScanner,
    })
    expect(code).toBe(0)
    expect(runScanner).toHaveBeenCalled()
  })

  it("reads Strix's vulnerability artifact instead of treating stdout as the report", async () => {
    const io = sink()
    const spawnScanner = ((_command: string, _args: string[], options: { cwd?: string }) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      void (async () => {
        const runDirectory = join(String(options.cwd), "strix_runs", "run-1")
        await mkdir(runDirectory, { recursive: true })
        await writeFile(join(runDirectory, "vulnerabilities.json"), CRITICAL, "utf8")
        child.stdout.write("scanner progress, not JSON\n")
        child.stdout.end()
        child.stderr.end()
        child.emit("close", 2)
      })()
      return child
    }) as never

    const outcome = await runStrixScanner({ target: "https://x", env, out: io.out }, spawnScanner)

    expect(outcome).toMatchObject({ exitCode: 2, artifact: CRITICAL })
    expect(io.stdout.join("")).toContain("scanner progress, not JSON")
  })
})

describe("security usage", () => {
  it("prints usage and exits 1 for an unknown subcommand", async () => {
    const io = sink()
    expect(await run(["security", "wat"], { out: io.out })).toBe(1)
    expect(io.stderr.join("\n")).toMatch(/security <report\|scan>/)
  })
})

describe("argv parsing", () => {
  it("keeps --authorized from swallowing the next token", () => {
    // Not declaring it boolean would make `--authorized --target x` consume
    // "--target" as the flag's value and lose the target entirely.
    const args = parseArgv(["security", "scan", "--authorized", "--target", "https://x"])
    expect(args.flags.authorized).toBe(true)
    expect(args.flags.target).toBe("https://x")
  })

  it("keeps --only-new from swallowing the next token", () => {
    const args = parseArgv(["security", "report", "--only-new", "--input", "r.json"])
    expect(args.flags["only-new"]).toBe(true)
    expect(args.flags.input).toBe("r.json")
  })

  it("treats security as a grouped command so the subcommand parses", () => {
    expect(parseArgv(["security", "report"]).subcommand).toBe("report")
  })
})
