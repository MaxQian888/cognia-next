import { bestOfNCommand, formatRun } from "./best-of-n-command"
import { parseArgv } from "./args"

const run = {
  groupId: "g1",
  phase: "awaitingSelection",
  n: 2,
  baseSha: "a".repeat(40),
  targetRef: "best-of-n/r",
  selectedCandidateId: null,
  archiveStatus: "pending",
  error: null,
  candidates: [
    {
      index: 1,
      candidateId: "c1",
      status: "succeeded",
      runtime: "cognia",
      agent: "char",
      model: "m",
      headSha: "b".repeat(40),
      hasChanges: true,
      costUsd: 0.25,
      error: null,
    },
    {
      index: 2,
      candidateId: "c2",
      status: "succeeded",
      runtime: "external",
      agent: "codex-1",
      model: null,
      headSha: "c".repeat(40),
      hasChanges: true,
      costUsd: null,
      error: null,
    },
  ],
}

function harness(results: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown>; token: string | null }> = []
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    calls.push({
      path,
      body: JSON.parse(String(init.body)),
      token: new Headers(init.headers).get("X-Cognia-Dev-Token"),
    })
    const action = path.split("/").pop()!
    const result = results[action] ?? { ok: true, run }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  })
  const output = { stdout: "", stderr: "", json: [] as unknown[] }
  const out = {
    write: (text: string) => void (output.stdout += text),
    error: (text: string) => void (output.stderr += text + "\n"),
    json: (value: unknown) => void output.json.push(value),
  }
  const ask = jest.fn(async () => "yes")
  const deps = {
    out,
    fetch: fetch as unknown as typeof globalThis.fetch,
    endpoint: { baseUrl: "http://127.0.0.1:9", devToken: "tok" },
    isTty: () => true,
    env: {},
    ask,
  }
  return { calls, output, deps, ask }
}
const argv = (...words: string[]) => parseArgv(["best-of-n", ...words])

it("starts with one agent per attempt through the desktop bridge", async () => {
  const h = harness()
  const code = await bestOfNCommand(
    argv("start", "--session", "s1", "--agents", "claude-code,codex", "fix", "the", "bug"),
    h.deps
  )
  expect(code).toBe(0)
  expect(h.calls).toEqual([
    {
      path: "/api/dev/best-of-n/start",
      body: { sessionId: "s1", prompt: "fix the bug", agents: ["claude-code", "codex"] },
      token: "tok",
    },
  ])
  expect(h.output.stdout).toContain("external:codex-1")
  expect(h.output.stdout).toContain("cost unknown")
})

it("validates start arguments before calling the desktop", async () => {
  const h = harness()
  expect(await bestOfNCommand(argv("start", "fix"), h.deps)).toBe(2)
  expect(await bestOfNCommand(argv("start", "--session", "s", "--n", "5", "fix"), h.deps)).toBe(2)
  expect(
    await bestOfNCommand(
      argv("start", "--session", "s", "--n", "3", "--agents", "a,b", "x"),
      h.deps
    )
  ).toBe(2)
  expect(
    await bestOfNCommand(
      argv("start", "--session", "s", "--target", "t", "--existing-branch", "main", "x"),
      h.deps
    )
  ).toBe(2)
  expect(h.calls).toEqual([])
})

it("lists and shows status, as text or JSON", async () => {
  const h = harness({ list: { ok: true, runs: [run] } })
  expect(await bestOfNCommand(argv("list", "--json"), h.deps)).toBe(0)
  expect(h.output.json).toEqual([{ ok: true, runs: [run] }])
  expect(await bestOfNCommand(argv("status", "g1"), h.deps)).toBe(0)
  expect(h.output.stdout).toBe(formatRun(run as never))
  expect(h.calls.map((call) => call.path)).toEqual([
    "/api/dev/best-of-n/list",
    "/api/dev/best-of-n/status",
  ])
})

it.each([
  [{ isTty: () => false }, [], "requires an interactive terminal"],
  [{ env: { CI: "1" } }, [], "refused in CI"],
  [{}, ["--yes"], "cannot be pre-approved with --yes"],
])(
  "refuses select and publish when no person can confirm (%#)",
  async (override, flags, message) => {
    for (const words of [
      ["select", "g1", "2"],
      ["publish", "g1"],
    ]) {
      const h = harness()
      const code = await bestOfNCommand(argv(...words, ...flags), { ...h.deps, ...override })
      expect(code).toBe(3)
      expect(h.output.stderr).toContain(message)
      expect(h.calls).toEqual([])
      expect(h.ask).not.toHaveBeenCalled()
    }
  }
)

it("asks on the terminal, then forwards the confirmed select", async () => {
  const h = harness({
    select: {
      ok: true,
      run,
      checks: [{ profileId: "unit", outcome: "passed", headSha: "c".repeat(40) }],
      requiredChecks: ["unit", "lint"],
    },
  })
  expect(await bestOfNCommand(argv("select", "g1", "2"), h.deps)).toBe(0)
  expect(h.ask).toHaveBeenCalledWith(expect.stringContaining("Select candidate 2"))
  expect(h.calls.at(-1)).toEqual({
    path: "/api/dev/best-of-n/select",
    body: { groupId: "g1", confirmedOnTty: true, candidate: "2" },
    token: "tok",
  })
  expect(h.output.stdout).toContain("check unit: passed")
  expect(h.output.stdout).toContain("not run: lint")
})

it("does nothing when the terminal answer is not yes", async () => {
  const h = harness()
  h.ask.mockResolvedValueOnce("no")
  expect(await bestOfNCommand(argv("publish", "g1"), h.deps)).toBe(3)
  expect(h.calls.map((call) => call.path)).toEqual(["/api/dev/best-of-n/status"])
})

it("reports a refused publish and a failed release with a failing exit code", async () => {
  const h = harness({
    publish: {
      ok: true,
      run,
      outcome: { kind: "blocked", reason: "target_checked_out_dirty" },
      releaseError: "abort refused",
      archiveError: null,
    },
  })
  expect(await bestOfNCommand(argv("publish", "g1"), h.deps)).toBe(1)
  expect(h.output.stderr).toContain("publish blocked: target_checked_out_dirty")
  expect(h.output.stderr).toContain("integration release failed: abort refused")
})

it("explains when the desktop is unreachable or refuses", async () => {
  const h = harness({ cancel: { ok: false, error: "Best-of-N group not found: g9" } })
  expect(await bestOfNCommand(argv("cancel", "g9"), h.deps)).toBe(1)
  expect(h.output.stderr).toContain("group not found")
  expect(await bestOfNCommand(argv("list"), { ...h.deps, endpoint: null })).toBe(1)
  expect(h.output.stderr).toContain("desktop app is not running")
  expect(await bestOfNCommand(argv("judge", "g1"), h.deps)).toBe(2)
})
