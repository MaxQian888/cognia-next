/** @jest-environment node */

import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { EvalProject } from "@cognia/eval-core"
import { evalCommand } from "./eval-command"
import { sealReplayFixture } from "../eval/replay/fixture-maintenance"
import type { OutputSink } from "./output"
import type { ReplayFixtureV1 } from "@/lib/ai/replay/fixture"

const environmentCompatibility = {
  checkedAt: 1,
  runtimeByVariant: { a: { available: true }, b: { available: true } },
  storage: { status: "available" as const, requiredBytes: 1, availableBytes: 100 },
}

const preflightProject = async (input: EvalProject) => ({
  project: input,
  environmentCompatibility,
  result: {
    ok: Boolean(input.variants.every((variant) => variant.isLocal || variant.price)),
    issues: input.variants.every((variant) => variant.isLocal || variant.price)
      ? []
      : [{ code: "PRICE_REQUIRED" as const, severity: "error" as const, message: "price" }],
    compatibleVariantIds: input.variants.map((variant) => variant.id),
    effectiveCaseIds: input.dataset.caseIds,
  },
})

const project = (ready = true): EvalProject => ({
  id: "project-1",
  name: "CLI selection",
  mode: "model",
  dataset: {
    datasetId: "dataset-1",
    version: 1,
    digest: "sha256:data",
    caseIds: Array.from({ length: 30 }, (_, i) => `c${i}`),
    holdoutCaseIds: Array.from({ length: 30 }, (_, i) => `c${i}`),
    requiredModalities: ["text"],
  },
  variants: ["a", "b"].map((id) => ({
    id,
    name: id,
    kind: "model" as const,
    providerId: `provider-${id}`,
    modelId: `model-${id}`,
    runtimeTarget: "web" as const,
    isLocal: false,
    price: ready ? { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 } : undefined,
    capabilities: ["text" as const],
    available: true,
    credentialReady: true,
  })),
  decisionPolicy: {
    formal: false,
    dimensions: [{ metric: "quality", direction: "maximize", weight: 1 }],
    constraints: [],
    confidenceLevel: 0.95,
    minimumEffectiveCases: 30,
  },
  budget: { currency: "USD", hardCap: 5, confirmed: true },
  judgePolicy: { enabled: false, calibrated: false, anchorCount: 0, kappa: 0, accuracy: 0 },
  privacyPolicy: { cloudPiiMode: "redact", mediaClearance: "local-only" },
  retentionDays: 90,
  createdAt: 1,
  updatedAt: 1,
})

const replayFixture: ReplayFixtureV1 = {
  scenario: {
    schemaVersion: 1,
    scenarioId: "cli-replay",
    title: "CLI replay",
    level: "canonical",
    platform: "headless",
    actors: [{ actorRef: "root", role: "root" }],
    inputSteps: [],
    permissionScript: [],
    expectations: { assertConsumed: true, fidelity: "full" },
  },
  tapes: [],
}

function sink() {
  const stdout: string[] = []
  const stderr: string[] = []
  const out: OutputSink = {
    write: (value) => stdout.push(value),
    error: (value) => stderr.push(value),
    json: (value) => stdout.push(JSON.stringify(value)),
  }
  return { out, stdout, stderr }
}

describe("cognia eval command", () => {
  it("returns 0 for a conclusive preflight and 2 for a blocked/no-conclusion preflight", async () => {
    const ok = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "preflight",
          positionals: ["project.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: ok.out },
        {
          readJson: async () => ({ schema: "cognia-eval-project/v1", project: project() }),
          preflightProject,
        }
      )
    ).toBe(0)
    expect(JSON.parse(ok.stdout.join(""))).toMatchObject({ ok: true })

    const blocked = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "preflight",
          positionals: ["project.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: blocked.out },
        {
          readJson: async () => ({ schema: "cognia-eval-project/v1", project: project(false) }),
          preflightProject,
        }
      )
    ).toBe(2)
  })

  it.each([
    ["completed", "recommended", 0],
    ["completed", "no_conclusion", 2],
    ["failed", undefined, 1],
    ["interrupted", undefined, 1],
    ["cancelled", undefined, 130],
  ] as const)("maps checkpoint %s/%s to exit %s", async (status, outcome, code) => {
    const output = sink()
    const checkpoint = { schema: "cognia-eval-checkpoint/v1", status, outcome }
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "status",
          positionals: ["checkpoint.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: output.out },
        { readJson: async () => checkpoint }
      )
    ).toBe(code)
  })

  it("passes run projects and checkpoint paths to the real executor seam", async () => {
    const output = sink()
    const executeProject = jest.fn(async () => ({
      exitCode: 2 as const,
      checkpoint: { status: "completed" },
    }))
    const writeJson = jest.fn(async () => {})
    const args = {
      command: "eval",
      subcommand: "run",
      positionals: ["project.json"],
      rest: [],
      flags: { checkpoint: "state.json" },
      help: false,
      version: false,
    }

    expect(
      await evalCommand(
        args,
        { out: output.out },
        {
          readJson: async () => ({ project: project() }),
          writeJson,
          executeProject,
          preflightProject,
        }
      )
    ).toBe(2)
    expect(executeProject).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.objectContaining({ id: "project-1" }) }),
      "state.json"
    )
    expect(writeJson).toHaveBeenCalledWith("state.json", { status: "completed" })
  })

  it("requires an export password before writing a replay bundle", async () => {
    const output = sink()

    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "export",
          positionals: ["checkpoint.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: output.out },
        { readJson: async () => ({ status: "completed", outcome: "recommended" }) }
      )
    ).toBe(1)
    expect(output.stderr.join(" ")).toContain("--password")
  })

  it("prints help for incomplete input and rejects unknown subcommands", async () => {
    const missing = sink()
    expect(
      await evalCommand(
        { command: "eval", positionals: [], flags: {}, rest: [], help: false, version: false },
        { out: missing.out }
      )
    ).toBe(1)
    expect(missing.stderr.join(" ")).toContain("Usage")

    const unknown = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "unknown",
          positionals: ["checkpoint.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: unknown.out },
        { readJson: async () => ({ status: "running" }) }
      )
    ).toBe(1)
    expect(unknown.stderr.join(" ")).toContain("Unknown")
  })

  it("prints reports and validates the run checkpoint option", async () => {
    const report = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "report",
          positionals: ["checkpoint.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: report.out },
        { readJson: async () => ({ status: "completed", outcome: "recommended" }) }
      )
    ).toBe(0)
    expect(report.stdout.join(" ")).toContain("recommended")

    const run = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "run",
          positionals: ["project.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: run.out }
      )
    ).toBe(1)
    expect(run.stderr.join(" ")).toContain("--checkpoint")
  })

  it("exports credential-free JSON, CSV, HTML, and encrypted replay formats", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cognia-eval-export-"))
    const prefix = path.join(directory, "report")
    const output = sink()
    const checkpoint = {
      projectId: "project-1",
      status: "completed",
      outcome: "recommended",
      samples: [
        {
          variantId: "a",
          caseId: 'case,"1',
          repetition: 1,
          status: "completed",
          quality: 1,
          cost: null,
          latencyMs: 10,
        },
      ],
      recommendation: { status: "recommended", recommendedVariantId: "a" },
      portableProject: {
        name: "CLI",
        mode: "model" as const,
        datasetDigest: "sha256:data",
        variants: [{ id: "a", name: "A" }],
        appVersion: "1.0.0",
        randomSeed: 42,
      },
    }

    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "export",
          positionals: [path.join(directory, "checkpoint.json")],
          rest: [],
          flags: { output: prefix, password: "strong password" },
          help: false,
          version: false,
        },
        { out: output.out },
        { readJson: async () => checkpoint }
      )
    ).toBe(0)
    expect(await readFile(`${prefix}.csv`, "utf8")).toContain("variantId,caseId")
    expect(await readFile(`${prefix}.html`, "utf8")).toContain("Cognia evaluation report")
    expect(JSON.parse(await readFile(`${prefix}.cognia-eval`, "utf8"))).toMatchObject({
      schema: "cognia-eval-bundle/v1",
    })
  })

  it("writes live replay recordings only as password-encrypted bundles", async () => {
    const output = sink()
    const writeJson = jest.fn(async (_pathname: string, _value: unknown) => {})
    const privateFixture = {
      scenario: {
        schemaVersion: 1 as const,
        scenarioId: "recorded",
        title: "Recorded",
        level: "runtime" as const,
        platform: "headless" as const,
        actors: [{ actorRef: "root", role: "root" as const }],
        inputSteps: [],
        permissionScript: [],
        expectations: { assertConsumed: true, fidelity: "full" as const },
      },
      tapes: [],
      assets: { private: ["sensitive model output"] },
      actors: ["root"],
    }

    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "record",
          positionals: ["scenario.json"],
          rest: [],
          flags: {
            live: true,
            output: "recording.cognia-replay",
            password: "strong replay password",
          },
          help: false,
          version: false,
        },
        { out: output.out },
        {
          readJson: async () => privateFixture,
          writeJson,
          waitForInterrupt: async () => undefined,
          recordSession: async (options) => {
            await options.waitForCompletion({
              baseUrl: "http://127.0.0.1:1234",
              baseUrlFor: (actorRef: string) => `http://127.0.0.1:1234/a/${actorRef}`,
            } as never)
            return privateFixture
          },
        }
      )
    ).toBe(0)

    expect(writeJson).toHaveBeenCalledWith(
      "recording.cognia-replay",
      expect.objectContaining({ schema: "cognia-replay-fixture-bundle/v1" })
    )
    expect(JSON.stringify(writeJson.mock.calls[0]?.[1])).not.toContain("sensitive model output")
  })

  it("requires a password before recording a live replay", async () => {
    const output = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "record",
          positionals: ["scenario.json"],
          rest: [],
          flags: { live: true, output: "recording.cognia-replay" },
          help: false,
          version: false,
        },
        { out: output.out },
        { readJson: async () => ({}) }
      )
    ).toBe(1)
    expect(output.stderr.join(" ")).toContain("--password")
  })

  it("replays raw and encrypted canonical fixtures", async () => {
    const rawOutput = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "replay",
          positionals: ["fixture.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: rawOutput.out },
        { readJson: async () => replayFixture }
      )
    ).toBe(0)
    expect(rawOutput.stdout.join(" ")).toContain("cli-replay")

    const password = "strong replay password"
    const encrypted = await sealReplayFixture(replayFixture, password)
    const encryptedOutput = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "replay",
          positionals: ["fixture.cognia-replay"],
          rest: [],
          flags: { password, platform: "tauri" },
          help: false,
          version: false,
        },
        { out: encryptedOutput.out },
        { readJson: async () => encrypted }
      )
    ).toBe(0)
  })

  it("refreshes raw fixtures and preserves encryption for encrypted fixtures", async () => {
    const rawWrite = jest.fn(async (_pathname: string, _value: unknown) => {})
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "refresh",
          positionals: ["fixture.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: sink().out },
        { readJson: async () => replayFixture, writeJson: rawWrite }
      )
    ).toBe(0)
    expect(rawWrite).toHaveBeenCalledWith("fixture.json", replayFixture)

    const password = "strong replay password"
    const encrypted = await sealReplayFixture(replayFixture, password)
    const encryptedWrite = jest.fn(async (_pathname: string, _value: unknown) => {})
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "refresh",
          positionals: ["fixture.cognia-replay"],
          rest: [],
          flags: { password, output: "refreshed.cognia-replay" },
          help: false,
          version: false,
        },
        { out: sink().out },
        { readJson: async () => encrypted, writeJson: encryptedWrite }
      )
    ).toBe(0)
    expect(encryptedWrite.mock.calls[0]?.[1]).toMatchObject({
      schema: "cognia-replay-fixture-bundle/v1",
    })
  })

  it("fails closed at replay, recording, refresh, and import guard rails", async () => {
    const encrypted = await sealReplayFixture(replayFixture, "strong replay password")
    const cases = [
      {
        subcommand: "replay",
        flags: {},
        readJson: async () => ({}),
        message: "fixture rejected",
      },
      {
        subcommand: "replay",
        flags: {},
        readJson: async () => encrypted,
        message: "--password",
      },
      {
        subcommand: "record",
        flags: {},
        readJson: async () => replayFixture,
        message: "--live",
      },
      {
        subcommand: "record",
        flags: { live: true },
        readJson: async () => replayFixture,
        message: "--output",
      },
      {
        subcommand: "refresh",
        flags: {},
        readJson: async () => encrypted,
        message: "--password",
      },
      {
        subcommand: "import",
        flags: {},
        readJson: async () => ({}),
        message: "--password",
      },
      {
        subcommand: "import",
        flags: { password: "strong password" },
        readJson: async () => ({}),
        message: "--output",
      },
    ] as const

    for (const testCase of cases) {
      const output = sink()
      expect(
        await evalCommand(
          {
            command: "eval",
            subcommand: testCase.subcommand,
            positionals: ["fixture.json"],
            rest: [],
            flags: testCase.flags,
            help: false,
            version: false,
          },
          { out: output.out },
          { readJson: testCase.readJson }
        )
      ).toBe(1)
      expect([...output.stdout, ...output.stderr].join(" ")).toContain(testCase.message)
    }
  })

  it("reports non-object and inconclusive checkpoint statuses", async () => {
    for (const [checkpoint, expected] of [
      [null, 1],
      [{ status: "completed", outcome: "no_conclusion" }, 2],
    ] as const) {
      expect(
        await evalCommand(
          {
            command: "eval",
            subcommand: "status",
            positionals: ["checkpoint.json"],
            rest: [],
            flags: {},
            help: false,
            version: false,
          },
          { out: sink().out },
          { readJson: async () => checkpoint }
        )
      ).toBe(expected)
    }
  })

  it("surfaces malformed project files and executor failures as configuration errors", async () => {
    const malformed = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "preflight",
          positionals: ["project.json"],
          rest: [],
          flags: {},
          help: false,
          version: false,
        },
        { out: malformed.out },
        { readJson: async () => ({}) }
      )
    ).toBe(1)
    expect(malformed.stderr.join(" ")).toContain("project object")

    const failed = sink()
    expect(
      await evalCommand(
        {
          command: "eval",
          subcommand: "run",
          positionals: ["project.json"],
          rest: [],
          flags: { checkpoint: "state.json" },
          help: false,
          version: false,
        },
        { out: failed.out },
        {
          readJson: async () => ({ project: project() }),
          preflightProject,
          executeProject: async () => {
            throw new Error("execution failed")
          },
        }
      )
    ).toBe(1)
    expect(failed.stderr.join(" ")).toContain("execution failed")
  })
})
