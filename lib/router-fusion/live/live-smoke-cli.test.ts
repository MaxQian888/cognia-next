/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import type { LiveSmokeReport } from "@cognia/router-fusion/live/report"

import {
  REPORT_DIR_NAME,
  REPORT_JSON,
  REPORT_MARKDOWN,
  runLiveSmokeCli,
  type LiveSmokeIo,
} from "./live-smoke-cli"

const SETTINGS_EXPORT = {
  schema: "cognia-settings",
  version: 1,
  settings: {
    providerSettings: {
      openai: {
        providerId: "openai",
        enabled: true,
        defaultModel: "gpt-4o-mini",
        enabledModels: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"],
        discoveredModels: ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"].map((id) => ({
          id,
          supportsStructuredOutput: true,
          supportsTools: true,
          contextLength: 128_000,
          maxOutputTokens: 16_384,
        })),
      },
    },
    modelMappings: [
      ["fast", "gpt-4o-mini"],
      ["balanced", "gpt-4.1-mini"],
      ["powerful", "gpt-4o"],
    ].map(([alias, modelId]) => ({
      id: `m-${alias}`,
      alias,
      providers: [{ providerId: "openai", modelId }],
      distribution: "priority",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    })),
  },
}

function memoryIo(files: Record<string, string> = {}) {
  const written = new Map<string, string>(Object.entries(files))
  let temps = 0
  const resolvePath = (...segments: string[]) =>
    segments.reduce(
      (path, segment) =>
        segment.startsWith("/") ? segment : `${path.replace(/\/$/, "")}/${segment}`,
      "/work"
    )
  const io: LiveSmokeIo = {
    tempRoot: "/tmp",
    resolvePath,
    readText: async (path) => {
      const content = written.get(path)
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return content
    },
    writeText: async (path, content) => {
      written.set(path, content)
    },
    makeTempDir: async (prefix) => `/tmp/${prefix}${++temps}`,
  }
  return { io, written }
}

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    sinks: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
  }
}

let fetchTrap: jest.Mock
const originalFetch = globalThis.fetch

beforeEach(() => {
  // Anything that reaches the network in these tests fails them.
  fetchTrap = jest.fn(async () => {
    throw new Error("a test reached the network")
  })
  globalThis.fetch = fetchTrap as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("runLiveSmokeCli", () => {
  it("prints the usage for --help and refuses bad options with exit 2", async () => {
    const help = capture()
    const { io } = memoryIo()
    await expect(runLiveSmokeCli({ argv: ["--help"], env: {}, io, ...help.sinks })).resolves.toBe(0)
    expect(help.out.join("\n")).toContain("Usage: pnpm router-fusion:live-smoke")
    const bad = capture()
    await expect(
      runLiveSmokeCli({ argv: ["--confirm", "--fake"], env: {}, io, ...bad.sinks })
    ).resolves.toBe(2)
    expect(bad.err[0]).toContain("cannot be combined")
  })

  it("--fake runs every case against the Fake Provider and writes a simulated report", async () => {
    const { io, written } = memoryIo()
    const logs = capture()
    const code = await runLiveSmokeCli({ argv: ["--fake"], env: {}, io, ...logs.sinks })
    expect(code).toBe(0)
    const jsonPath = [...written.keys()].find((path) => path.endsWith(`/${REPORT_JSON}`))!
    expect(jsonPath).toMatch(new RegExp(`^/tmp/${REPORT_DIR_NAME}/.+-simulated/${REPORT_JSON}$`))
    const report = JSON.parse(written.get(jsonPath)!) as LiveSmokeReport
    expect(report.label).toBe("simulated")
    expect(report.cases.map((entry) => [entry.id, entry.outcome])).toEqual([
      ["direct", "succeeded"],
      ["cascade", "succeeded"],
      ["panel", "succeeded"],
      ["delegate", "skipped"],
    ])
    expect(report.cases[3].detail).toBe("skipped: delegate not available in this build")
    expect(report.network).toEqual({ mode: "blocked", requests: 0, blocked: 0 })
    expect(written.get(jsonPath.replace(REPORT_JSON, REPORT_MARKDOWN))).toContain(
      "# Router + Fusion live smoke: SIMULATED"
    )
    // The fixture repository was written to a temp dir, and the report names it.
    expect(report.fixtureRoot).toMatch(/^\/tmp\/cognia-live-smoke-fixture-/)
    expect(written.get(`${report.fixtureRoot}/.cognia/workspace.json`)).toContain(
      "acceptanceProfiles"
    )
    expect(logs.out.join("\n")).toContain(`Report (simulated): /tmp/${REPORT_DIR_NAME}/`)
    expect(fetchTrap).not.toHaveBeenCalled()
    // The guard put the process's fetch back.
    expect(globalThis.fetch).toBe(fetchTrap)
  })

  it("--fake writes to --out when given", async () => {
    const { io, written } = memoryIo()
    await runLiveSmokeCli({ argv: ["--fake", "--out", "reports"], env: {}, io, ...capture().sinks })
    expect(written.has(`/work/reports/${REPORT_JSON}`)).toBe(true)
    expect(written.has(`/work/reports/${REPORT_MARKDOWN}`)).toBe(true)
  })

  it("dry run without settings prints the plan and says where providers come from", async () => {
    const { io, written } = memoryIo()
    const logs = capture()
    await expect(runLiveSmokeCli({ argv: [], env: {}, io, ...logs.sinks })).resolves.toBe(0)
    const text = logs.out.join("\n")
    expect(text).toContain("DRY RUN")
    expect(text).toContain("Providers: unknown (no settings export given")
    expect(text).toContain("Σ case caps $4.800000 of the $5.000000 total")
    expect(text).toContain("Network requests during this dry run: 0")
    expect(written.size).toBe(0)
  })

  it("dry run with a settings export lists the providers and routes every case, sending nothing", async () => {
    const { io, written } = memoryIo({ "/work/export.json": JSON.stringify(SETTINGS_EXPORT) })
    const logs = capture()
    const code = await runLiveSmokeCli({
      argv: ["--settings", "export.json"],
      env: { COGNIA_LIVE_SMOKE_KEY_OPENAI: "sk-test-not-used" },
      io,
      ...logs.sinks,
    })
    expect(code).toBe(0)
    const text = logs.out.join("\n")
    expect(text).toContain("Settings: /work/export.json")
    expect(text).toMatch(/\[x\] openai\s+builtin, enabled, key COGNIA_LIVE_SMOKE_KEY_OPENAI: found/)
    expect(text).toMatch(/\[ \] anthropic/)
    expect(text).toContain("→ direct_baseline: solver=openai::gpt-4o")
    expect(text).toContain("→ skipped: delegate not available in this build")
    expect(text).toContain("router: delegate_code:SANDBOX_UNAVAILABLE")
    expect(text).toContain(
      "pnpm router-fusion:live-smoke --settings /work/export.json --providers openai --confirm"
    )
    expect(written.size).toBe(1)
    expect(fetchTrap).not.toHaveBeenCalled()
  })

  it("--confirm refuses to start without a settings export", async () => {
    const { io } = memoryIo()
    const logs = capture()
    await expect(
      runLiveSmokeCli({ argv: ["--confirm"], env: {}, io, ...logs.sinks })
    ).resolves.toBe(2)
    expect(logs.err[0]).toMatch(
      /^live-smoke: refusing to start: --confirm needs the settings export/
    )
  })

  it("--confirm refuses to start when no provider is confirmed", async () => {
    const { io } = memoryIo({ "/work/export.json": JSON.stringify(SETTINGS_EXPORT) })
    const logs = capture()
    await expect(
      runLiveSmokeCli({
        argv: ["--confirm", "--settings", "export.json"],
        env: {},
        io,
        ...logs.sinks,
      })
    ).resolves.toBe(2)
    expect(logs.err[0]).toContain("no provider is confirmed")
  })

  it("--confirm refuses to start when a routed deployment has no credential, before anything is sent", async () => {
    const { io, written } = memoryIo({ "/work/export.json": JSON.stringify(SETTINGS_EXPORT) })
    const logs = capture()
    const code = await runLiveSmokeCli({
      argv: ["--confirm", "--settings", "export.json", "--providers", "openai"],
      env: {},
      io,
      ...logs.sinks,
    })
    expect(code).toBe(2)
    expect(logs.out.join("\n")).toContain("! no usable credential for openai::gpt-4o")
    expect(logs.err[0]).toContain("nothing was sent")
    expect(written.size).toBe(1)
    expect(fetchTrap).not.toHaveBeenCalled()
  })

  it("--confirm refuses providers the settings do not configure", async () => {
    const { io } = memoryIo({ "/work/export.json": JSON.stringify(SETTINGS_EXPORT) })
    const logs = capture()
    await expect(
      runLiveSmokeCli({
        argv: ["--confirm", "--settings", "export.json", "--providers", "openai,nope"],
        env: {},
        io,
        ...logs.sinks,
      })
    ).resolves.toBe(2)
    expect(logs.err[0]).toContain("do not configure: nope")
  })

  it("refuses a settings file that is not an export", async () => {
    const { io } = memoryIo({
      "/work/export.json": JSON.stringify({ schema: "other", version: 1 }),
    })
    const logs = capture()
    await expect(
      runLiveSmokeCli({ argv: ["--settings", "export.json"], env: {}, io, ...logs.sinks })
    ).resolves.toBe(2)
    expect(logs.err[0]).toContain("not a settings export")
  })
})
