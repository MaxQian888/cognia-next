/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  DEFAULT_LIMITS_BY_MODE,
  FAKE_SEMANTICS,
  FakeProvider,
  MemoryApprovalPort,
  MemoryCallLedger,
  SPEC_MOCK_REGISTRY,
  WorkflowError,
  delegateLimitsOf,
  junitFixture,
  runDelegateWorkflow,
  type DelegateRunInput,
  type DelegateRunOutcome,
  type DelegateRunPorts,
  type FakeStep,
  type RoleCallExecutor,
  type RoleCallRequest,
  type WorkflowEvent,
} from "@cognia/router-fusion"

import { fusionContentCodec } from "../db/content-codec"
import { FusionDB } from "../db/fusion-db"
import { FusionLedgerStore } from "../db/ledger-store"
import type { ApprovedAcceptanceProfile } from "../verify/acceptance-profiles"
import type {
  AcceptanceRunSpec,
  AcceptanceSandboxAvailability,
  AcceptanceSandboxHost,
} from "../verify/code-acceptance-host"
import { gitWorkspaceRevision, type DelegateWorkspaceHost } from "../tools/workspace-patch"
import { createDelegateHostPorts } from "./delegate-host-ports"

const NOW = 1_800_000_000_000

// ── a real git checkout in a temp directory ──────────────────────────────────

const roots: string[] = []
const worktrees: string[] = []
const disposed: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim()
}

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cognia-d3-"))
  roots.push(root)
  mkdirSync(join(root, "src/users"), { recursive: true })
  writeFileSync(join(root, "src/users/list.ts"), "export const list = []\n")
  writeFileSync(join(root, "README.md"), "# fixture\n")
  git(root, "init", "-q", "-b", "main")
  git(root, "add", "-A")
  git(root, "-c", "user.email=d3@test", "-c", "user.name=d3", "commit", "-q", "-m", "fixture")
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** The workspace host over node's filesystem and the real git binary. */
function nodeWorkspaceHost(workspaceRoot: string): DelegateWorkspaceHost {
  const walk = (root: string, prefix: string): string[] => {
    const out: string[] = []
    const visit = (relative: string) => {
      const absolute = join(root, relative)
      for (const entry of readdirSync(absolute, { withFileTypes: true })) {
        if (entry.name === ".git") continue
        const next = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) visit(next)
        else out.push(next)
      }
    }
    visit("")
    return out
      .filter((path) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`))
      .sort()
  }
  // Self-referential on purpose: the revision bridge computes from the very
  // host it belongs to, exactly as the production fallback does.
  const host: DelegateWorkspaceHost = {
    async revision(root) {
      return gitWorkspaceRevision(root, host)
    },
    async readFile(root, relPath, maxBytes) {
      const content = readFileSync(join(root, relPath), "utf8")
      return content.length > maxBytes ? `${content.slice(0, maxBytes)}\n... (truncated)` : content
    },
    async writeFile(root, relPath, content) {
      mkdirSync(dirname(join(root, relPath)), { recursive: true })
      writeFileSync(join(root, relPath), content)
    },
    async deleteEntry(root, relPath) {
      rmSync(join(root, relPath), { force: true })
    },
    async stat(root, relPath) {
      const absolute = join(root, relPath)
      if (!existsSync(absolute)) return { exists: false, isDir: false, size: 0, mtimeMs: null }
      const stat = lstatSync(absolute)
      return {
        exists: true,
        isDir: stat.isDirectory(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        isSymlink: stat.isSymbolicLink(),
      }
    },
    async list(root, prefix, limit) {
      const all = walk(root, prefix)
      return {
        files: all.slice(0, limit).map((path) => ({
          path,
          sizeBytes: statSync(join(root, path)).size,
          mtimeMs: statSync(join(root, path)).mtimeMs,
        })),
        truncated: all.length > limit,
      }
    },
    async headRevision(root) {
      return git(root, "rev-parse", "HEAD")
    },
    async dirtyEntries(root) {
      return git(root, "status", "--porcelain")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => `${line.slice(0, 2).trim()}:0:${line.slice(3).trim()}`)
    },
    async openStaging({ purpose }) {
      // The run's isolated worktrees: a copy of the checkout, without its
      // history. Production provisions them through
      // `lib/task-workspace/client.ts` / WP-D6's task-workspace service.
      const root = mkdtempSync(join(tmpdir(), `cognia-d3-${purpose}-`))
      roots.push(root)
      worktrees.push(root)
      cpSync(workspaceRoot, root, { recursive: true, filter: (from) => !from.includes("/.git") })
      return { root, taskRunId: null }
    },
    async disposeStaging({ root }) {
      disposed.push(root)
      rmSync(root, { recursive: true, force: true })
    },
    async applyPatch({ workspaceRoot: target, patch }) {
      for (const file of patch.files) {
        if (file.action === "delete") rmSync(join(target, file.path), { force: true })
        else {
          mkdirSync(dirname(join(target, file.path)), { recursive: true })
          writeFileSync(join(target, file.path), file.content ?? "")
        }
      }
      return { status: "applied" as const }
    },
  }
  return host
}

// ── the acceptance profile, run for real in a child process ──────────────────

const PASS_XML = junitFixture([{ name: "race condition", status: "passed" }])
const FAIL_XML = junitFixture([
  { name: "race condition", status: "failed", message: "the list is still unguarded" },
])

/** A test command that reads the staged file and writes a JUnit report. */
const CHECK_SCRIPT = [
  "const fs = require('node:fs');",
  "const src = fs.readFileSync('src/users/list.ts', 'utf8');",
  "const ok = src.includes('guarded');",
  "fs.mkdirSync('reports', { recursive: true });",
  `fs.writeFileSync('reports/junit.xml', ok ? ${JSON.stringify(PASS_XML)} : ${JSON.stringify(FAIL_XML)});`,
  "process.exit(ok ? 0 : 1)",
].join("")

const PROFILE: ApprovedAcceptanceProfile = {
  projectId: "project-1",
  profileId: "unit",
  source: "repository",
  commandHash: "c".repeat(64),
  approvedAt: NOW,
  configRoot: "",
  command: [process.execPath, "-e", CHECK_SCRIPT],
  cwd: ".",
  report: { format: "junit", path: "reports/junit.xml" },
  requiredTests: ["race condition"],
  timeoutMs: 60_000,
}

/**
 * The OS tier stands in for the sandbox here: jest has no container runtime,
 * and the runner is injectable precisely so this can run the real command on
 * the real staged tree. The payload the production bridges build (network off,
 * writable = the worktree) is asserted in `code-acceptance-host.test.ts`.
 */
function localSandbox(
  availability: AcceptanceSandboxAvailability = { microvm: false, container: false, os: true }
): AcceptanceSandboxHost & { runs: AcceptanceRunSpec[] } {
  const runs: AcceptanceRunSpec[] = []
  return {
    runs,
    async availability() {
      return availability
    },
    async run(spec) {
      runs.push(spec)
      const cwd = spec.cwd === "." ? spec.worktreeRoot : join(spec.worktreeRoot, spec.cwd)
      let exitCode = 0
      let stdout = ""
      try {
        stdout = execFileSync(spec.argv[0], spec.argv.slice(1), {
          cwd,
          encoding: "utf8",
          timeout: spec.limits.timeoutMs,
          env: spec.env,
        })
      } catch (error) {
        exitCode = (error as { status?: number }).status ?? 1
        stdout = String((error as { stdout?: string }).stdout ?? "")
      }
      const reportPath = join(spec.worktreeRoot, spec.reportPath)
      return {
        exitCode,
        timedOut: false,
        stdout,
        stderr: "",
        report: existsSync(reportPath)
          ? { content: readFileSync(reportPath, "utf8"), truncated: false }
          : { content: null, truncated: false },
        // What THIS runner enforced, named as itself: the report records the
        // attestation, never the tier the policy asked for.
        confinement: {
          networkEnforced: true,
          backend: "jest-child-process",
          maxMemoryMb: spec.limits.memoryMb,
          maxCpuSeconds: spec.limits.cpuSeconds,
          maxProcesses: null,
          platform: process.platform,
        },
      }
    },
  }
}

// ── the scripted models ──────────────────────────────────────────────────────

type Step = FakeStep | { kind: "tools"; calls: Array<{ name: string; arguments: unknown }> }

function scripted(
  steps: Record<string, Step[]>,
  beforeCall?: (role: string, index: number) => void
) {
  const seen: Record<string, number> = {}
  let current: Step = { kind: "text", text: "" }
  const fake = new FakeProvider(() => current as FakeStep)
  const requests: RoleCallRequest[] = []
  const executor: RoleCallExecutor = {
    async call(request, signal) {
      requests.push(request)
      const list = steps[request.role] ?? [{ kind: "text", text: `unscripted ${request.role}` }]
      const index = seen[request.role] ?? 0
      seen[request.role] = index + 1
      beforeCall?.(request.role, index)
      current = list[Math.min(index, list.length - 1)]
      if (current.kind === "tools") {
        return {
          outcome: "ok",
          text: "",
          usage: { inputTokens: 40, outputTokens: 8 },
          semantics: FAKE_SEMANTICS,
          providerRequestId: `mock:${request.attemptId}`,
          finishReason: "tool_calls",
          toolCalls: current.calls.map((call, i) => ({
            id: `${request.attemptId}:tool:${i}`,
            name: call.name,
            arguments: call.arguments as Record<string, unknown>,
          })),
        }
      }
      return fake.call(request, signal)
    },
  }
  return { executor, requests }
}

const plan = (): Step => ({
  kind: "json",
  value: {
    status: "ready",
    subtasks: [
      {
        goal: "Guard the users list refresh",
        allowed_paths: ["src/users"],
        constraints: [],
        acceptance: ["the race-condition test passes"],
        max_steps: 4,
      },
    ],
    questions: [],
  },
})

const read = (path: string): Step => ({
  kind: "tool_call",
  name: "workspace_read",
  arguments: { path },
})

const write = (content: string): Step => ({
  kind: "tool_call",
  name: "propose_patch",
  arguments: { path: "src/users/list.ts", action: "write", content },
})

const done = (): Step => ({
  kind: "json",
  value: {
    status: "completed",
    summary: "Guarded the list refresh with a request token.",
    claimed_check_ids: ["every test passes"],
    open_questions: [],
  },
})

const FIXED = "export const list = guarded([])\n"
const BROKEN = "export const list = still_broken([])\n"

// ── the world ────────────────────────────────────────────────────────────────

let counter = 0

interface WorldOptions {
  delivery?: "patch_only" | "workspace_updated"
  approve?: boolean
  sandbox?: AcceptanceSandboxHost & { runs: AcceptanceRunSpec[] }
  worker?: Step[]
  repairs?: number
  /** Runs before each model call: the seam a mid-run edit arrives through. */
  beforeCall?: (role: string, index: number) => void
}

function world(workspaceRoot: string, options: WorldOptions = {}) {
  const name = `fusion-d3-e2e-${++counter}`
  const store = new FusionLedgerStore({
    db: new FusionDB(name),
    codec: fusionContentCodec(name),
    now: () => NOW,
  })
  let id = 0
  const newId = () => `99999999-9999-4999-8999-${String(++id).padStart(12, "0")}`
  const sandbox = options.sandbox ?? localSandbox()
  const ports = createDelegateHostPorts({
    runId: "run-delegate-host-1",
    projectId: "project-1",
    workspaceRoot,
    acceptanceProfileId: "unit",
    store,
    now: () => NOW,
    newId,
    workspaceHost: nodeWorkspaceHost(workspaceRoot),
    sandbox,
    resolveProfile: async (profileId) =>
      profileId === "unit"
        ? { ok: true, profile: PROFILE }
        : { ok: false, code: "ACCEPTANCE_PROFILE_MISSING", message: "no such profile" },
  })
  const { executor, requests } = scripted(
    { lead: [plan()], worker: options.worker ?? [write(FIXED), done()] },
    options.beforeCall
  )
  const events: WorkflowEvent[] = []
  const approvals = new MemoryApprovalPort(() => (options.approve ? "approved" : undefined))
  const ledger = new MemoryCallLedger({
    capMicrousd: 5_000_000,
    maxModelCalls: 24,
    deployments: Object.fromEntries(SPEC_MOCK_REGISTRY.deployments.map((d) => [d.id, d])),
    rateCards: Object.fromEntries(SPEC_MOCK_REGISTRY.rate_cards.map((c) => [c.id, c])),
  })
  const runPorts: DelegateRunPorts = {
    ledger,
    executor,
    events: { emit: async (event) => void events.push(event) },
    clock: { now: () => NOW },
    sleep: async () => undefined,
    artifacts: store.artifactStore("run-delegate-host-1"),
    newId,
    approvals,
    ...ports,
  }
  const input: DelegateRunInput = {
    runId: "run-delegate-host-1",
    lead: { deploymentId: "fake-baseline", contextLimit: 65_536 },
    worker: { deploymentId: "fake-economy", contextLimit: 65_536 },
    messages: [{ role: "user", content: "Fix the pagination race in the users list." }],
    acceptanceProfileId: "unit",
    outputTokens: { lead: 1_024, worker: 1_024, reviewer: 512 },
    reserveFor: () => 5_000,
    limits: {
      ...delegateLimitsOf(DEFAULT_LIMITS_BY_MODE.delegate),
      workerRepairRounds: options.repairs ?? 0,
      leadTakeovers: 0,
    },
    task: "code.debug",
    allowDegraded: false,
    delivery: options.delivery ?? "patch_only",
    deadlineAt: NOW + 900_000,
    signal: new AbortController().signal,
  }
  return { ports, runPorts, input, sandbox, store, requests, events, approvals }
}

function completed(outcome: DelegateRunOutcome) {
  if (outcome.kind !== "completed") throw new Error(`expected completed, got ${outcome.kind}`)
  return outcome
}

const readFixture = (root: string) => readFileSync(join(root, "src/users/list.ts"), "utf8")

describe("createDelegateHostPorts end to end", () => {
  it("runs a delegate turn against a real checkout: verified in a sandbox, delivered as a patch", async () => {
    const root = fixtureRepo()
    const w = world(root)
    const outcome = completed(await runDelegateWorkflow(w.runPorts, w.input))

    // The acceptance command really ran, on the staged tree, at the revision
    // the report is about.
    expect(w.sandbox.runs).toHaveLength(1)
    const spec = w.sandbox.runs[0]
    expect(spec.tier).toBe("os")
    expect(spec.argv).toEqual(PROFILE.command)
    expect(spec.worktreeRoot).not.toBe(root)
    expect(readFileSync(join(spec.worktreeRoot, "src/users/list.ts"), "utf8")).toBe(FIXED)
    expect(existsSync(join(spec.worktreeRoot, "reports/junit.xml"))).toBe(true)

    expect(outcome.result).toMatchObject({
      mode_executed: "delegate",
      delivery: "patch_only",
      quality_status: "accepted",
      verification: { status: "passed", level: "tool_verified" },
    })
    expect(outcome.sandboxTier).toBe("os")
    expect(outcome.result.verification.revision).toBe(outcome.resultRevision)
    expect(outcome.deliveredRevision).toBeNull()
    // [ACC:DEL-01] the worker claimed the tests pass; the acceptance report is
    // what accepted it, and the claim is recorded as not counted.
    expect(outcome.result.warnings).toContain("worker_claims_not_counted")
    expect(
      outcome.result.verification.checks.find((check) => check.check_id === "worker_claims")?.status
    ).toBe("not_applicable")

    // patch_only: the person's checkout is exactly as they left it.
    expect(readFixture(root)).toBe("export const list = []\n")
    expect(git(root, "status", "--porcelain")).toBe("")

    // The tool receipts of the run are recorded against the delegate policy.
    const operations = await w.store.db.fusionToolOperations.toArray()
    expect(operations.map((row) => [row.policyId, row.toolName, row.status])).toEqual([
      ["delegate-work-1", "propose_patch", "succeeded"],
    ])
  })

  it("fails the run when the staged code does not pass, and never claims it did", async () => {
    const root = fixtureRepo()
    const w = world(root, { worker: [write(BROKEN), done()] })
    await expect(runDelegateWorkflow(w.runPorts, w.input)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    })
    expect(readFixture(root)).toBe("export const list = []\n")
    expect(w.sandbox.runs).toHaveLength(1)
  })

  it("repairs once from the objective failure report and then passes", async () => {
    const root = fixtureRepo()
    const w = world(root, {
      repairs: 1,
      worker: [write(BROKEN), done(), write(FIXED), done()],
    })
    const outcome = completed(await runDelegateWorkflow(w.runPorts, w.input))
    expect(outcome.repairs).toBe(1)
    expect(w.sandbox.runs).toHaveLength(2)
    expect(outcome.result.verification.status).toBe("passed")
  })

  it("[ACC:DEL-04] applies to the workspace after an approval, and refuses when it moved", async () => {
    const root = fixtureRepo()
    const approved = world(root, { delivery: "workspace_updated", approve: true })
    const outcome = completed(await runDelegateWorkflow(approved.runPorts, approved.input))
    expect(outcome.result.delivery).toBe("workspace_updated")
    expect(outcome.deliveredRevision).not.toBeNull()
    expect(readFixture(root)).toBe(FIXED)
    expect(approved.approvals.requests.map((request) => request.kind)).toEqual(["workspace_apply"])

    // A second run on a checkout somebody edits mid-run: the compare-and-swap
    // refuses, and the person's edit is still there.
    const other = fixtureRepo()
    const moving = world(other, { delivery: "workspace_updated", approve: true })
    const apply = moving.ports.workspace.applyPatchCAS.bind(moving.ports.workspace)
    jest.spyOn(moving.ports.workspace, "applyPatchCAS").mockImplementation(async (request) => {
      writeFileSync(join(other, "src/users/list.ts"), "export const list = mine()\n")
      return apply(request)
    })
    await expect(runDelegateWorkflow(moving.runPorts, moving.input)).rejects.toMatchObject({
      code: "PATCH_CONFLICT",
    })
    expect(readFixture(other)).toBe("export const list = mine()\n")
  })

  it("waits for a person instead of applying to the workspace on its own", async () => {
    const root = fixtureRepo()
    const w = world(root, { delivery: "workspace_updated", approve: false })
    const outcome = await runDelegateWorkflow(w.runPorts, w.input)
    expect(outcome.kind).toBe("waiting_for_approval")
    expect(readFixture(root)).toBe("export const list = []\n")
  })

  it("refuses the run with SANDBOX_UNAVAILABLE when this device has no tier", async () => {
    const root = fixtureRepo()
    const w = world(root, {
      sandbox: localSandbox({ microvm: false, container: false, os: false }),
    })
    const error = await runDelegateWorkflow(w.runPorts, w.input).catch((cause) => cause)
    expect(error).toBeInstanceOf(WorkflowError)
    expect(error).toMatchObject({ code: "SANDBOX_UNAVAILABLE" })
    expect(w.sandbox.runs).toEqual([])
    expect(readFixture(root)).toBe("export const list = []\n")
  })

  it("runs to the end while the person keeps editing, and reads its own snapshot", async () => {
    const root = fixtureRepo()
    const edited = "export const list = the_person_was_here()\n"
    const w = world(root, {
      worker: [read("src/users/list.ts"), write(FIXED), done()],
      // The person saves over the same file between the worker's two turns.
      beforeCall: (role, index) => {
        if (role === "worker" && index === 1) writeFileSync(join(root, "src/users/list.ts"), edited)
      },
    })
    const outcome = completed(await runDelegateWorkflow(w.runPorts, w.input))

    // The read the worker got is the base revision's content, not the edit.
    const operations = await w.store.db.fusionToolOperations.toArray()
    const readRow = operations.find((row) => row.toolName === "workspace_read")
    const shown = readRow?.summaryArtifactId
      ? await w.store.artifactStore("run-delegate-host-1").get(readRow.summaryArtifactId)
      : null
    expect(shown?.content).toContain("export const list = []")
    expect(shown?.content).not.toContain("the_person_was_here")

    // The staged tree the sandbox verified is base + patch, with none of the
    // edit in it, and the acceptance passed on that revision.
    const spec = w.sandbox.runs[0]
    expect(readFileSync(join(spec.worktreeRoot, "src/users/list.ts"), "utf8")).toBe(FIXED)
    expect(outcome.result.verification.status).toBe("passed")
    expect(outcome.result.verification.revision).toBe(outcome.resultRevision)

    // And the person's own edit is untouched: patch_only wrote nothing.
    expect(readFixture(root)).toBe(edited)
  })

  it("[ACC:SAFE-02] records the confinement the runner attested, and gives the worktrees back", async () => {
    const root = fixtureRepo()
    const w = world(root)
    const outcome = completed(await runDelegateWorkflow(w.runPorts, w.input))
    const attested = outcome.acceptanceReport?.checks.find(
      (check) => check.check_id === "sandbox_confinement"
    )
    expect(attested).toMatchObject({ status: "passed", executed_by: "runtime" })
    expect(attested?.summary).toContain("network=off_enforced")
    expect(attested?.summary).toContain("backend=jest-child-process")
    expect(attested?.summary).toContain("tier=os")

    const before = disposed.length
    await w.ports.workspace.dispose()
    expect(disposed.length - before).toBe(2)
    expect(existsSync(w.sandbox.runs[0].worktreeRoot)).toBe(false)
  })

  it("journals every side effect, so a resumed run replays instead of repeating", async () => {
    const root = fixtureRepo()
    const w = world(root)
    await runDelegateWorkflow(w.runPorts, w.input)
    // The same ports, the same input: every journalled step replays and the
    // acceptance command is not run a second time.
    const again = completed(await runDelegateWorkflow(w.runPorts, w.input))
    expect(w.sandbox.runs).toHaveLength(1)
    expect(again.result.verification.status).toBe("passed")
  })
})
