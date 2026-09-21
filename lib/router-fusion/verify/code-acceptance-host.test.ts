import { judgeRuntimeAcceptance, junitFixture, type SandboxTier } from "@cognia/router-fusion"

import type { ApprovedAcceptanceProfile } from "./acceptance-profiles"
import {
  ACCEPTANCE_ENV,
  ACCEPTANCE_REPORT_MAX_BYTES,
  ACCEPTANCE_WORKSPACE_FOLDER,
  acceptanceLimitsFor,
  buildAcceptanceContainerSpec,
  buildAcceptanceExecPayload,
  containerSpecRefusal,
  createAcceptanceSandboxHost,
  createDelegateAcceptancePort,
  createDockerAcceptanceContainerRuntime,
  defaultAcceptanceSandboxHost,
  OS_TIER_PLATFORMS,
  pinnedImageOrNull,
  resolveProjectContainerImage,
  selectSandboxTier,
  type AcceptanceCommandOutcome,
  type AcceptanceDockerClient,
  type AcceptanceRunSpec,
  type AcceptanceSandboxHost,
} from "./code-acceptance-host"

const WORKTREE = "/staged/1"
const REVISION = "staged:abc"
const PINNED_IMAGE = `registry.test/acceptance@sha256:${"d".repeat(64)}`

const PROFILE: ApprovedAcceptanceProfile = {
  projectId: "project-1",
  profileId: "unit",
  source: "repository",
  commandHash: "c".repeat(64),
  approvedAt: 1_700_000_000_000,
  configRoot: "/work/repo",
  command: ["pnpm", "exec", "jest", "--reporters=jest-junit"],
  cwd: "packages/api",
  report: { format: "junit", path: "reports/junit.xml" },
  requiredTests: ["race condition"],
  timeoutMs: 120_000,
}

const PASS_XML = junitFixture([
  { name: "lists users", status: "passed" },
  { name: "race condition", status: "passed" },
])
const FAIL_XML = junitFixture([
  { name: "lists users", status: "passed" },
  { name: "race condition", status: "failed", message: "expected 2 rows, got 3" },
])

function spec(overrides: Partial<AcceptanceRunSpec> = {}): AcceptanceRunSpec {
  return {
    runId: "run-1",
    logicalStepId: "delegate:verify:1",
    tier: "container",
    worktreeRoot: WORKTREE,
    cwd: PROFILE.cwd,
    argv: [...PROFILE.command],
    env: { ...ACCEPTANCE_ENV },
    limits: acceptanceLimitsFor(PROFILE.timeoutMs),
    reportPath: PROFILE.report.path,
    reportMaxBytes: ACCEPTANCE_REPORT_MAX_BYTES,
    image: PINNED_IMAGE,
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A sandbox that records what it was asked to run and answers a script. */
function fakeSandbox(
  availability: { microvm: boolean; container: boolean; os: boolean },
  outcome: AcceptanceCommandOutcome | ((spec: AcceptanceRunSpec) => AcceptanceCommandOutcome)
): AcceptanceSandboxHost & { runs: AcceptanceRunSpec[] } {
  const runs: AcceptanceRunSpec[] = []
  return {
    runs,
    async availability() {
      return availability
    },
    async run(request) {
      runs.push(request)
      return typeof outcome === "function" ? outcome(request) : outcome
    },
  }
}

const ATTESTED = {
  networkEnforced: true,
  backend: "seatbelt",
  maxMemoryMb: 4_096,
  maxCpuSeconds: 240,
  maxProcesses: null,
  platform: "macos",
} as const

const passing: AcceptanceCommandOutcome = {
  exitCode: 0,
  timedOut: false,
  stdout: "2 passed",
  stderr: "",
  report: { content: PASS_XML, truncated: false },
  confinement: { ...ATTESTED },
}

function acceptancePort(
  sandbox: AcceptanceSandboxHost,
  overrides: Partial<Parameters<typeof createDelegateAcceptancePort>[0]> = {}
) {
  let id = 0
  return createDelegateAcceptancePort({
    runId: "run-1",
    rootForRevision: async (revision) => (revision === REVISION ? WORKTREE : null),
    resolveProfile: async (profileId) =>
      profileId === "unit"
        ? { ok: true, profile: PROFILE }
        : { ok: false, code: "ACCEPTANCE_PROFILE_MISSING", message: `no profile ${profileId}` },
    sandbox,
    newId: () => `11111111-1111-4111-8111-${String(++id).padStart(12, "0")}`,
    ...overrides,
  })
}

const request = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-1",
  logicalStepId: "delegate:verify:1",
  profileId: "unit",
  revision: REVISION,
  signal: new AbortController().signal,
  ...overrides,
})

describe("selectSandboxTier", () => {
  it("takes the strongest tier available, and null when there is none", () => {
    expect(selectSandboxTier({ microvm: true, container: true, os: true })).toBe("microvm")
    expect(selectSandboxTier({ microvm: false, container: true, os: true })).toBe("container")
    expect(selectSandboxTier({ microvm: false, container: false, os: true })).toBe("os")
    expect(selectSandboxTier({ microvm: false, container: false, os: false })).toBeNull()
  })
})

describe("acceptanceLimitsFor", () => {
  it("derives cpu seconds from the wall clock and keeps the memory and pids ceilings", () => {
    const limits = acceptanceLimitsFor(120_000)
    expect(limits).toMatchObject({ timeoutMs: 120_000, cpuSeconds: 240 })
    expect(limits.memoryMb).toBeGreaterThan(0)
    expect(limits.pids).toBeGreaterThan(0)
    expect(acceptanceLimitsFor(0).timeoutMs).toBe(1_000)
    expect(acceptanceLimitsFor(120_000, { memoryMb: 512 }).memoryMb).toBe(512)
  })
})

describe("[ACC:SAFE-02] the container spec", () => {
  it("has no network, mounts only the worktree and carries every ceiling", () => {
    const built = buildAcceptanceContainerSpec(spec())
    expect(built.network).toBe("none")
    expect(built.mounts).toEqual([
      { source: WORKTREE, target: ACCEPTANCE_WORKSPACE_FOLDER, readOnly: false },
    ])
    expect(built.workingDir).toBe(`${ACCEPTANCE_WORKSPACE_FOLDER}/packages/api`)
    expect(built.argv).toEqual(PROFILE.command)
    expect(built.capDrop).toEqual(["ALL"])
    expect(built.securityOpt).toEqual(["no-new-privileges"])
    expect(built.autoRemove).toBe(true)
    expect(built.memoryMb).toBeGreaterThan(0)
    expect(built.pidsLimit).toBeGreaterThan(0)
    expect(Number(built.cpus)).toBeGreaterThan(0)
    expect(built.timeoutMs).toBe(PROFILE.timeoutMs)
    expect(containerSpecRefusal(built)).toBeNull()
  })

  it("mounts nothing of the host: no docker socket, no home, no credential directory", () => {
    const built = buildAcceptanceContainerSpec(spec())
    const sources = built.mounts.map((mount) => mount.source)
    expect(sources).not.toContain("/var/run/docker.sock")
    for (const source of [
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/Users/me/.ssh",
      "/home/me/.aws",
      "/proc",
      "/sys",
    ]) {
      expect(
        containerSpecRefusal({
          ...built,
          mounts: [{ source, target: ACCEPTANCE_WORKSPACE_FOLDER, readOnly: false }],
        })
      ).toContain("refused mount source")
    }
    expect(containerSpecRefusal({ ...built, network: "bridge" as "none" })).toContain("no network")
    expect(
      containerSpecRefusal({ ...built, mounts: [...built.mounts, ...built.mounts] })
    ).toContain("and nothing else")
    expect(containerSpecRefusal({ ...built, pidsLimit: 0 })).toContain("ceilings")
  })

  it("inherits nothing from this machine's environment", () => {
    const built = buildAcceptanceContainerSpec(spec())
    expect(built.env).toEqual({ ...ACCEPTANCE_ENV })
    expect(Object.keys(built.env)).not.toContain("AWS_ACCESS_KEY_ID")
    expect(JSON.stringify(built.env)).not.toMatch(/token|secret|key=/i)
  })

  it("refuses to build a container spec with no pinned image", () => {
    expect(() => buildAcceptanceContainerSpec(spec({ image: null }))).toThrow("pinned image")
  })
})

describe("[ACC:SAFE-02] the OS and microVM payload", () => {
  it("runs with the network off, inside the worktree and under the ceilings", () => {
    const payload = buildAcceptanceExecPayload(spec({ tier: "os" }))
    expect(payload.request.network).toBe("off")
    expect(payload.request.networkHosts).toEqual([])
    expect(payload.request.writable).toEqual([WORKTREE])
    expect(payload.request.readable).toEqual([WORKTREE])
    expect(payload.request.maxCpuSeconds).toBeGreaterThan(0)
    expect(payload.request.maxMemoryMb).toBeGreaterThan(0)
    expect(payload.command.cwd).toBe(`${WORKTREE}/packages/api`)
    expect(payload.command.argv).toEqual(PROFILE.command)
    expect(payload.command.timeout).toBe(120)
    expect(payload.command.env).toEqual({ ...ACCEPTANCE_ENV })
    expect(buildAcceptanceExecPayload(spec({ cwd: "." })).command.cwd).toBe(WORKTREE)
  })
})

describe("createDelegateAcceptancePort", () => {
  it("runs the approved command on the staged revision and reports a believable pass", async () => {
    const sandbox = fakeSandbox({ microvm: false, container: true, os: true }, passing)
    const port = acceptancePort(sandbox, { image: PINNED_IMAGE })
    const outcome = await port.runProfile(request())

    expect(sandbox.runs).toHaveLength(1)
    expect(sandbox.runs[0]).toMatchObject({
      tier: "container",
      worktreeRoot: WORKTREE,
      cwd: "packages/api",
      argv: PROFILE.command,
      reportPath: "reports/junit.xml",
      reportMaxBytes: ACCEPTANCE_REPORT_MAX_BYTES,
    })
    if (outcome.kind !== "report") throw new Error(`expected a report, got ${outcome.kind}`)
    expect(outcome.report).toMatchObject({
      status: "passed",
      level: "tool_verified",
      revision: REVISION,
    })
    expect(outcome.report.checks.find((check) => check.check_id === "sandbox")?.summary).toBe(
      "tier=container"
    )
    expect(outcome.report.checks.every((check) => check.executed_by === "runtime")).toBe(true)
    // The package's own belief rules accept it for this revision, and no other.
    expect(judgeRuntimeAcceptance(outcome.report, REVISION).status).toBe("passed")
    expect(judgeRuntimeAcceptance(outcome.report, "staged:other").status).toBe("inconclusive")
  })

  it("records the tier it fell back to", async () => {
    const sandbox = fakeSandbox({ microvm: false, container: false, os: true }, passing)
    const outcome = await acceptancePort(sandbox).runProfile(request())
    expect(sandbox.runs[0].tier).toBe("os")
    if (outcome.kind !== "report") throw new Error("expected a report")
    expect(outcome.report.checks.find((check) => check.check_id === "sandbox")?.summary).toBe(
      "tier=os"
    )
    expect(judgeRuntimeAcceptance(outcome.report, REVISION).tier).toBe<SandboxTier>("os")
  })

  it("refuses with SANDBOX_UNAVAILABLE when no tier exists, and runs nothing", async () => {
    const sandbox = fakeSandbox({ microvm: false, container: false, os: false }, passing)
    const outcome = await acceptancePort(sandbox).runProfile(request())
    expect(outcome).toMatchObject({ kind: "refused", code: "SANDBOX_UNAVAILABLE" })
    expect(sandbox.runs).toEqual([])
  })

  it("refuses when the tier probe itself fails, rather than running unconfined", async () => {
    const sandbox: AcceptanceSandboxHost = {
      availability: async () => {
        throw new Error("the sandbox host is unreachable")
      },
      run: async () => passing,
    }
    await expect(acceptancePort(sandbox).runProfile(request())).resolves.toMatchObject({
      kind: "refused",
      code: "SANDBOX_UNAVAILABLE",
    })
  })

  it("passes a profile refusal through with its own code", async () => {
    const sandbox = fakeSandbox({ microvm: false, container: false, os: true }, passing)
    await expect(
      acceptancePort(sandbox).runProfile(request({ profileId: "nope" }))
    ).resolves.toMatchObject({ kind: "refused", code: "ACCEPTANCE_PROFILE_MISSING" })
    const unapproved = acceptancePort(sandbox, {
      resolveProfile: async () => ({
        ok: false,
        code: "ACCEPTANCE_PROFILE_UNAPPROVED",
        message: "approve the command first",
      }),
    })
    await expect(unapproved.runProfile(request())).resolves.toMatchObject({
      kind: "refused",
      code: "ACCEPTANCE_PROFILE_UNAPPROVED",
    })
    expect(sandbox.runs).toEqual([])
  })

  it("refuses a revision no staged worktree holds", async () => {
    const sandbox = fakeSandbox({ microvm: false, container: false, os: true }, passing)
    await expect(
      acceptancePort(sandbox).runProfile(request({ revision: "staged:unknown" }))
    ).resolves.toMatchObject({ kind: "refused", code: "ACCEPTANCE_REVISION_UNAVAILABLE" })
    expect(sandbox.runs).toEqual([])
  })

  it("[ACC:DEL-05] refuses an approved profile whose report path leaves the worktree", async () => {
    const sandbox = fakeSandbox({ microvm: false, container: false, os: true }, passing)
    const port = acceptancePort(sandbox, {
      resolveProfile: async () => ({
        ok: true,
        profile: { ...PROFILE, report: { format: "junit", path: "../../../etc/passwd" } },
      }),
    })
    await expect(port.runProfile(request())).resolves.toMatchObject({
      kind: "refused",
      code: "ACCEPTANCE_REPORT_PATH_REFUSED",
    })
    expect(sandbox.runs).toEqual([])
  })

  it("[ACC:DEL-02] a green exit over a report with no tests is a failure, not a pass", async () => {
    const sandbox = fakeSandbox(
      { microvm: false, container: true, os: true },
      {
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        report: { content: junitFixture([]), truncated: false },
        confinement: { ...ATTESTED },
      }
    )
    const outcome = await acceptancePort(sandbox).runProfile(request())
    if (outcome.kind !== "report") throw new Error("expected a report")
    expect(outcome.report.status).toBe("failed")
    expect(judgeRuntimeAcceptance(outcome.report, REVISION).status).toBe("failed")
  })

  it("reports a failing run, a timeout and a missing report without inventing a verdict", async () => {
    const failing = fakeSandbox(
      { microvm: false, container: true, os: true },
      {
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "1 failed",
        report: { content: FAIL_XML, truncated: false },
        confinement: { ...ATTESTED },
      }
    )
    const failed = await acceptancePort(failing).runProfile(request())
    expect(failed.kind === "report" && failed.report.status).toBe("failed")

    const timedOut = fakeSandbox(
      { microvm: false, container: true, os: true },
      {
        exitCode: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        report: { content: null, truncated: false },
        confinement: { ...ATTESTED },
      }
    )
    const inconclusive = await acceptancePort(timedOut).runProfile(request())
    expect(inconclusive.kind === "report" && inconclusive.report.status).toBe("inconclusive")

    const truncated = fakeSandbox(
      { microvm: false, container: true, os: true },
      {
        exitCode: 0,
        timedOut: false,
        stdout: "",
        stderr: "",
        report: { content: PASS_XML, truncated: true },
        confinement: { ...ATTESTED },
      }
    )
    const capped = await acceptancePort(truncated).runProfile(request())
    expect(capped.kind === "report" && capped.report.status).toBe("inconclusive")
  })

  it("refuses when the sandbox cannot run the command at all", async () => {
    const sandbox: AcceptanceSandboxHost = {
      availability: async () => ({ microvm: false, container: false, os: true }),
      run: async () => {
        throw new Error("the seatbelt profile was rejected")
      },
    }
    await expect(acceptancePort(sandbox).runProfile(request())).resolves.toMatchObject({
      kind: "refused",
      code: "SANDBOX_RUN_FAILED",
    })
  })

  it("keeps the command's output and the report as evidence artifacts", async () => {
    let stored = 0
    const put = jest.fn(async (content: string) => ({
      artifactId: `artifact-${++stored}`,
      contentSha256: "0".repeat(64),
      sizeBytes: content.length,
      mediaType: "text/plain",
    }))
    const sandbox = fakeSandbox({ microvm: false, container: true, os: true }, passing)
    const outcome = await acceptancePort(sandbox, {
      artifacts: { put },
      image: PINNED_IMAGE,
    }).runProfile(request())
    if (outcome.kind !== "report") throw new Error("expected a report")
    expect(outcome.report.artifact_refs).toEqual(["artifact-1", "artifact-2"])
    expect(put.mock.calls[0][0]).toContain("tier=container")
    expect(put.mock.calls[1][0]).toBe(PASS_XML)
  })
})

describe("the container image (ADR-0182)", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`

  it("accepts only a pinned reference", () => {
    expect(pinnedImageOrNull(`registry.test/acceptance@${DIGEST}`)).toBe(
      `registry.test/acceptance@${DIGEST}`
    )
    expect(pinnedImageOrNull("registry.test/acceptance:latest")).toBeNull()
    expect(pinnedImageOrNull("registry.test/acceptance")).toBeNull()
    expect(pinnedImageOrNull(`acceptance@${DIGEST}`)).toBeNull()
    expect(pinnedImageOrNull(`registry.test/acceptance@sha256:${"z".repeat(64)}`)).toBeNull()
    expect(pinnedImageOrNull(null)).toBeNull()
    expect(pinnedImageOrNull(undefined)).toBeNull()
  })

  it("resolves the project's runtime environment image, and nothing else", async () => {
    await expect(
      resolveProjectContainerImage({
        projectId: "project-1",
        resolve: async () => ({
          kind: "placed",
          placement: {
            spec: { image: { registry: "registry.test", repository: "team/api", digest: DIGEST } },
          },
        }),
      })
    ).resolves.toBe(`registry.test/team/api@${DIGEST}`)

    // A project that selected no environment, a deployment that could not
    // place one, an unpinned image, an unreachable pool: all "no image".
    for (const outcome of [
      { kind: "off" },
      { kind: "fallback" },
      { kind: "refused" },
      { kind: "placed", placement: { spec: {} } },
      {
        kind: "placed",
        placement: {
          spec: { image: { registry: "registry.test", repository: "team/api", digest: "latest" } },
        },
      },
    ]) {
      await expect(
        resolveProjectContainerImage({ projectId: "p", resolve: async () => outcome })
      ).resolves.toBeNull()
    }
    await expect(
      resolveProjectContainerImage({
        projectId: "p",
        resolve: async () => {
          throw new Error("the pool is unreachable")
        },
      })
    ).resolves.toBeNull()
  })

  it("offers the container tier only with a pinned image, and lets an explicit one win", async () => {
    const available = { microvm: false, container: true, os: true }

    const resolved = fakeSandbox(available, passing)
    await acceptancePort(resolved, {
      resolveImage: async () => `registry.test/from-project@${DIGEST}`,
    }).runProfile(request())
    expect(resolved.runs[0]).toMatchObject({
      tier: "container",
      image: `registry.test/from-project@${DIGEST}`,
    })

    const override = fakeSandbox(available, passing)
    await acceptancePort(override, {
      image: PINNED_IMAGE,
      resolveImage: async () => `registry.test/from-project@${DIGEST}`,
    }).runProfile(request())
    expect(override.runs[0]).toMatchObject({ tier: "container", image: PINNED_IMAGE })

    // Unpinned, or none at all: the tier is not offered and the run falls to
    // the OS tier rather than running an image that could change tomorrow.
    const unpinned = fakeSandbox(available, passing)
    await acceptancePort(unpinned, {
      resolveImage: async () => "registry.test/from-project:latest",
    }).runProfile(request())
    expect(unpinned.runs[0]).toMatchObject({ tier: "os", image: null })

    const none = fakeSandbox({ microvm: false, container: true, os: false }, passing)
    await expect(acceptancePort(none).runProfile(request())).resolves.toMatchObject({
      kind: "refused",
      code: "SANDBOX_UNAVAILABLE",
    })
  })

  it("asks the project for its image once per run", async () => {
    const resolveImage = jest.fn(async () => `registry.test/from-project@${DIGEST}`)
    const sandbox = fakeSandbox({ microvm: false, container: true, os: true }, passing)
    const port = acceptancePort(sandbox, { resolveImage })
    await port.runProfile(request())
    await port.runProfile(request())
    expect(resolveImage).toHaveBeenCalledTimes(1)
  })
})

describe("[ACC:SAFE-02] what the report says was enforced", () => {
  it("records the runner's attestation, not what the policy asked for", async () => {
    const sandbox = fakeSandbox(
      { microvm: false, container: false, os: true },
      {
        ...passing,
        confinement: {
          networkEnforced: true,
          backend: "seatbelt",
          maxMemoryMb: 4_096,
          maxCpuSeconds: 240,
          // macOS has no pids cap: the report says so instead of implying one.
          maxProcesses: null,
          platform: "macos",
        },
      }
    )
    const outcome = await acceptancePort(sandbox).runProfile(request())
    if (outcome.kind !== "report") throw new Error("expected a report")
    const check = outcome.report.checks.find((entry) => entry.check_id === "sandbox_confinement")
    expect(check).toMatchObject({ status: "passed", executed_by: "runtime", kind: "sandbox" })
    expect(check?.summary).toBe(
      "tier=os network=off_enforced backend=seatbelt platform=macos memory_mb=4096 cpu_seconds=240 processes=unbounded"
    )
    // The report is still believable for the revision it names.
    expect(judgeRuntimeAcceptance(outcome.report, REVISION).status).toBe("passed")
  })

  it("refuses a run no tier attested, rather than reporting it as verified", async () => {
    const sandbox = fakeSandbox(
      { microvm: false, container: false, os: true },
      {
        ...passing,
        confinement: null,
      }
    )
    await expect(acceptancePort(sandbox).runProfile(request())).resolves.toMatchObject({
      kind: "refused",
      code: "SANDBOX_CONFINEMENT_UNATTESTED",
    })
  })
})

describe("createAcceptanceSandboxHost", () => {
  const bridges = () => {
    const execs: unknown[] = []
    const files = new Map<string, string>([[`${WORKTREE}/reports/junit.xml`, PASS_XML]])
    return {
      execs,
      files,
      host: (overrides: Record<string, unknown> = {}) =>
        createAcceptanceSandboxHost({
          microvm: async () => null,
          osConfined: async () => true,
          platform: async () => "macos",
          execOs: async (payload) => {
            execs.push(payload)
            return {
              exit_code: 0,
              stdout: "ok",
              stderr: "",
              duration: 1,
              timed_out: false,
              confinement: { ...ATTESTED },
            }
          },
          readReport: async (root, relPath) => {
            const content = files.get(`${root}/${relPath}`)
            return content === undefined
              ? { kind: "missing" as const }
              : { kind: "ok" as const, content }
          },
          container: null,
          ...overrides,
        }),
    }
  }

  it("reports which tiers this device has", async () => {
    const world = bridges()
    await expect(world.host().availability()).resolves.toEqual({
      microvm: false,
      container: false,
      os: true,
    })
    await expect(
      world
        .host({
          microvm: async () => ({ execute: async () => ({}) }),
          container: { available: async () => true, run: async () => passing },
        })
        .availability()
    ).resolves.toEqual({ microvm: true, container: true, os: true })
    // Windows has no OS tier: WP-D6's runner refuses `network: "off"` there.
    await expect(world.host({ platform: async () => "windows" }).availability()).resolves.toEqual({
      microvm: false,
      container: false,
      os: false,
    })
    await expect(world.host({ platform: async () => "linux" }).availability()).resolves.toEqual({
      microvm: false,
      container: false,
      os: true,
    })
    await expect(world.host({ platform: async () => "unknown" }).availability()).resolves.toEqual({
      microvm: false,
      container: false,
      os: false,
    })
    expect([...OS_TIER_PLATFORMS].sort()).toEqual(["darwin", "linux", "macos"])
    // A probe that throws is "not available", never "assume yes".
    await expect(
      world
        .host({
          microvm: async () => {
            throw new Error("bridge is gone")
          },
          osConfined: async () => {
            throw new Error("probe failed")
          },
          platform: async () => {
            throw new Error("no platform")
          },
        })
        .availability()
    ).resolves.toEqual({ microvm: false, container: false, os: false })
  })

  it("runs the OS tier with the network-off payload and collects the report from the worktree", async () => {
    const world = bridges()
    const outcome = await world.host().run(spec({ tier: "os" }))
    expect(world.execs).toEqual([buildAcceptanceExecPayload(spec({ tier: "os" }))])
    expect(outcome).toMatchObject({
      exitCode: 0,
      timedOut: false,
      report: { content: PASS_XML, truncated: false },
      confinement: { networkEnforced: true, backend: "seatbelt", platform: "macos" },
    })
  })

  it("[ACC:SAFE-02] refuses a run the tier did not attest, and one it could not confine", async () => {
    const world = bridges()
    await expect(
      world
        .host({
          execOs: async () => ({
            exit_code: 0,
            stdout: "",
            stderr: "",
            duration: 1,
            timed_out: false,
          }),
        })
        .run(spec({ tier: "os" }))
    ).rejects.toThrow("did not attest")
    await expect(
      world
        .host({
          execOs: async () => ({
            exit_code: 0,
            stdout: "",
            stderr: "",
            duration: 1,
            timed_out: false,
            confinement: { networkEnforced: false, backend: "none" },
          }),
        })
        .run(spec({ tier: "os" }))
    ).rejects.toThrow("did not attest")
    // Exit 3: the runner says this machine cannot confine the run at all.
    await expect(
      world
        .host({
          execOs: async () => ({
            exit_code: 3,
            stdout: "",
            stderr: "confinement unavailable",
            duration: 0,
            timed_out: false,
            confinement: { ...ATTESTED },
          }),
        })
        .run(spec({ tier: "os" }))
    ).rejects.toThrow("could not confine")
  })

  it("reports a report past the cap as absent-and-truncated, never half-parsed", async () => {
    const world = bridges()
    const outcome = await world
      .host({ readReport: async () => ({ kind: "too_large" as const }) })
      .run(spec({ tier: "os" }))
    expect(outcome.report).toEqual({ content: null, truncated: true })
  })

  it("treats a report the command never wrote as absent, not as an error", async () => {
    const world = bridges()
    world.files.clear()
    const outcome = await world.host().run(spec({ tier: "os" }))
    expect(outcome.report).toEqual({ content: null, truncated: false })
    const refusedRead = await world
      .host({ readReport: async () => ({ kind: "refused" as const, code: "PATH_SYMLINK" }) })
      .run(spec({ tier: "os" }))
    expect(refusedRead.report).toEqual({ content: null, truncated: false })
  })

  it("refuses the container tier when no container runtime is registered", async () => {
    const world = bridges()
    await expect(world.host().run(spec({ tier: "container" }))).rejects.toThrow(
      "no container runtime"
    )
  })

  it("hands the container runtime a spec it has already checked", async () => {
    const world = bridges()
    const seen: unknown[] = []
    const outcome = await world
      .host({
        container: {
          available: async () => true,
          run: async (containerSpec: unknown, context: unknown) => {
            seen.push({ containerSpec, context })
            return passing
          },
        },
      })
      .run(spec({ tier: "container" }))
    expect(outcome).toBe(passing)
    expect(seen).toEqual([
      {
        containerSpec: buildAcceptanceContainerSpec(spec()),
        context: {
          runId: "run-1",
          logicalStepId: "delegate:verify:1",
          reportContainerPath: `${ACCEPTANCE_WORKSPACE_FOLDER}/reports/junit.xml`,
          reportMaxBytes: ACCEPTANCE_REPORT_MAX_BYTES,
          signal: expect.anything(),
        },
      },
    ])
  })

  it("runs the microVM tier through the registered adapter and reads the report back", async () => {
    const calls: Array<{ ownerRef: string; argv: string[] }> = []
    const released: string[] = []
    const world = bridges()
    const outcome = await world
      .host({
        microvm: async () => ({
          preflight: async () => undefined,
          execute: async (ownerRef: string, payload: { command: { argv: string[] } }) => {
            calls.push({ ownerRef, argv: payload.command.argv })
            return {
              exit_code: 0,
              stdout: "ok",
              stderr: "",
              duration: 2,
              timed_out: false,
              confinement: { ...ATTESTED, backend: "microvm", platform: "linux" },
            }
          },
          release: async (ownerRef: string) => void released.push(ownerRef),
        }),
      })
      .run(spec({ tier: "microvm" }))
    expect(calls.map((call) => call.argv[0])).toEqual(["pnpm"])
    expect(calls[0].ownerRef).toBe("router-fusion-delegate:run-1:delegate:verify:1")
    expect(released).toEqual(["router-fusion-delegate:run-1:delegate:verify:1"])
    expect(outcome.report).toEqual({ content: PASS_XML, truncated: false })
    expect(outcome.confinement).toMatchObject({ networkEnforced: true, backend: "microvm" })
  })
})

describe("createDockerAcceptanceContainerRuntime", () => {
  function dockerClient(
    state: Partial<{
      status: string
      running: boolean
      paused: boolean
      networkMode: string
      nanoCpus: number
      memoryBytes: number
    }> = {}
  ) {
    const calls: string[] = []
    const client: AcceptanceDockerClient = {
      async create(connectionId, image, policy) {
        calls.push(`create:${connectionId}:${image}:${JSON.stringify(policy)}`)
        return { containerId: "c1", port: 0 }
      },
      async start(connectionId) {
        calls.push(`start:${connectionId}`)
        return { containerId: "c1", port: 0 }
      },
      async inspect() {
        return {
          status: "running",
          running: true,
          paused: false,
          networkMode: "none",
          nanoCpus: 2_000_000_000,
          memoryBytes: 4_294_967_296,
          ...state,
        }
      },
      async exec(connectionId, exec) {
        calls.push(`exec:${exec.argv.join(" ")}@${exec.cwd}`)
        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 10,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }
      },
      async readFile(_connectionId, path) {
        calls.push(`read:${path}`)
        return PASS_XML
      },
      async delete(connectionId) {
        calls.push(`delete:${connectionId}`)
      },
    }
    return { client, calls }
  }

  const context = {
    runId: "run-1",
    logicalStepId: "delegate:verify:1",
    reportContainerPath: `${ACCEPTANCE_WORKSPACE_FOLDER}/reports/junit.xml`,
    reportMaxBytes: ACCEPTANCE_REPORT_MAX_BYTES,
    signal: new AbortController().signal,
  }

  it("is unavailable while the host cannot enforce the whole spec", async () => {
    const { client } = dockerClient()
    const runtime = createDockerAcceptanceContainerRuntime({ client, fullSpecSupported: false })
    await expect(runtime.available()).resolves.toBe(false)
    await expect(runtime.run(buildAcceptanceContainerSpec(spec()), context)).rejects.toThrow(
      "pids and capability ceilings"
    )
  })

  it("[ACC:SAFE-02] creates the container with no network, runs it and deletes it", async () => {
    const { client, calls } = dockerClient()
    const runtime = createDockerAcceptanceContainerRuntime({ client, fullSpecSupported: true })
    const outcome = await runtime.run(buildAcceptanceContainerSpec(spec()), context)

    expect(calls[0]).toContain('"networkMode":"none"')
    expect(calls[0]).toContain(`"workspaceHostPath":"${WORKTREE}"`)
    expect(calls[0]).toContain('"workspaceContainerPath":"/workspace"')
    expect(calls[0]).toContain('"pidsLimit"')
    expect(calls[0]).not.toContain("docker.sock")
    expect(calls).toContain(
      `exec:pnpm exec jest --reporters=jest-junit@${ACCEPTANCE_WORKSPACE_FOLDER}/packages/api`
    )
    expect(calls.at(-1)).toBe("delete:router-fusion-acceptance:run-1:delegate:verify:1")
    expect(outcome).toMatchObject({
      exitCode: 0,
      timedOut: false,
      report: { content: PASS_XML, truncated: false },
    })
  })

  it("[ACC:SAFE-02] refuses to run when Docker's own view is not the spec, and cleans up", async () => {
    const { client, calls } = dockerClient({ networkMode: "bridge" })
    const runtime = createDockerAcceptanceContainerRuntime({ client, fullSpecSupported: true })
    await expect(runtime.run(buildAcceptanceContainerSpec(spec()), context)).rejects.toThrow(
      'network "bridge"'
    )
    expect(calls.some((call) => call.startsWith("exec:"))).toBe(false)
    expect(calls.at(-1)).toBe("delete:router-fusion-acceptance:run-1:delegate:verify:1")

    const uncapped = dockerClient({ nanoCpus: 0 })
    await expect(
      createDockerAcceptanceContainerRuntime({
        client: uncapped.client,
        fullSpecSupported: true,
      }).run(buildAcceptanceContainerSpec(spec()), context)
    ).rejects.toThrow("no cpu or memory ceiling")
  })
})

describe("defaultAcceptanceSandboxHost", () => {
  it("is wired to this device's real bridges, and fails closed when it has none", async () => {
    // Rule 7 dormancy: no microVM adapter is registered in a test host, the OS
    // sandbox is not confining, and the container tier stays unoffered until
    // WP-D6's runner can enforce the whole spec. The port then refuses instead
    // of running delegated code unconfined.
    const availability = await defaultAcceptanceSandboxHost().availability()
    expect(availability).toEqual({ microvm: false, container: false, os: false })
    expect(selectSandboxTier(availability)).toBeNull()

    const port = acceptancePort(defaultAcceptanceSandboxHost())
    await expect(port.runProfile(request())).resolves.toMatchObject({
      kind: "refused",
      code: "SANDBOX_UNAVAILABLE",
    })
  })
})
