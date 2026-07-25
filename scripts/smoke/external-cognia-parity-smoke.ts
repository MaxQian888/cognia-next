/**
 * Real-agent smoke for the Cognia tool bridge (ADR external-hosting parity).
 *
 * Unit tests and the bridge integration fixture both stub the AGENT. This runs
 * the real one — `codex app-server` or Claude Code over ACP — through the real
 * `ExternalAgentManager`, the real sandbox launcher, the real broker and the
 * real bridge, and asserts the thing that actually matters:
 *
 *   the agent invoked at least one READ-ONLY and one MUTATING Cognia tool
 *   through the host bridge, and Cognia authorized and recorded both.
 *
 * Anything less proves the plumbing compiles, not that a hosted agent can use
 * Cognia's tools. Run it with:
 *
 *   pnpm smoke:external-parity            # every installed backend
 *   pnpm smoke:external-parity codex      # one backend
 *
 * Not part of `pnpm test`: it needs the agents installed AND logged in, and it
 * spends real tokens.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"

import { createExternalAgentSession } from "@/cli/src/agent/external-agent-session"
import { createPermissionGate } from "@/cli/src/agent/permission-gate"
import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "@/cli/src/config/schema"
import { readToolHostStatus } from "@/cli/src/agent/tool-host/status"
import { useAskUserStore } from "@/stores/agent/ask-user-store"
import type { TranscriptFs } from "@/cli/src/agent/transcript"

/** Backends this smoke knows how to drive, in the order it tries them. */
const BACKENDS = ["codex-app-server", "codex", "claude-code"] as const
type Backend = (typeof BACKENDS)[number]

/**
 * The read-only and mutating Cognia tools the agent is told to call by name.
 *
 * Both come from the `coreFiles` plane — the surface a real coding session
 * actually leans on. `git_status` is called too but only REPORTED: the git
 * tools shell out, and under the strict launcher sandbox that subprocess cannot
 * reach the repo, so gating on it would measure the sandbox rather than the
 * bridge. The observation is printed so the gap stays visible.
 */
const READ_TOOL = "read"
const WRITE_TOOL = "write"
const PROBE_TOOL = "git_status"
const HOST_TOOL = "ask_user"

/** Arguments are spelled out: the point is the BRIDGE, not the agent's guessing. */
function prompt(cwd: string): string {
  return [
    "You are running a plumbing check. Do exactly this and nothing else:",
    `1. Call \`mcp__cognia-tools__${READ_TOOL}\` with {"file_path": "${cwd}/README.md"}.`,
    `2. Call \`mcp__cognia-plugin-tools__${HOST_TOOL}\` with`,
    '   {"question": "Continue the smoke?", "options": [{"value": "yes", "label": "Yes"}]}.',
    `3. Call \`mcp__cognia-tools__${WRITE_TOOL}\` with`,
    `   {"file_path": "${cwd}/SMOKE.txt", "content": "cognia parity ok"}.`,
    `4. Call \`mcp__cognia-tools__${PROBE_TOOL}\` with {"cwd": "${cwd}"}.`,
    "5. Reply with the single word DONE.",
    "Do not use your own built-in file or shell tools — use the mcp__cognia-tools__ ones.",
    "If a tool returns an error, continue to the next step anyway.",
  ].join("\n")
}

/**
 * A scratch git repo, so `git_status` has something real to report.
 *
 * It lives UNDER the repo, not in the temp dir: the strict sandbox launcher
 * validates that the agent's cwd is inside the workspaces root, and refusing an
 * arbitrary /tmp path is the launcher working correctly — the smoke has to play
 * by the same rule a real session does.
 */
function makeWorkspace(root: string): string {
  const dir = fs.mkdtempSync(path.join(root, ".smoke-workspace-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "smoke\n")
  return dir
}

/** Walk up to the repo root (the workspaces root the launcher enforces). */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
}

const memoryTranscript = (): TranscriptFs => ({
  append: () => undefined,
  read: () => null,
  mkdirp: () => undefined,
  write: () => undefined,
})

function config(backend: Backend, cwd: string): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    cwd,
    agentBackend: backend,
    // Both planes on: the read tool is in `git`, the write tool in `coreFiles`.
    builtinTools: { ...DEFAULT_BUILTIN_TOOLS, git: true, coreFiles: true },
    // Keep the real approval policy active: the read and host tools should
    // auto-run, while the one mutating write must cross exactly one gate.
    permissionMode: "default",
    streamIdleTimeoutMs: 180_000,
  }
}

interface Observed {
  calls: string[]
  results: { name: string; ok: boolean; summary: string }[]
}

async function runBackend(
  backend: Backend,
  root: string
): Promise<{ ok: boolean; detail: string }> {
  const cwd = makeWorkspace(root)
  const observed: Observed = { calls: [], results: [] }
  let approvalPrompts = 0
  const unsubscribeAskUser = useAskUserStore.subscribe((state) => {
    if (!state.active) return
    state.resolveActive({ selected: ["yes"], text: "", cancelled: false })
  })
  const session = createExternalAgentSession({
    config: config(backend, cwd),
    home: fs.mkdtempSync(path.join(os.tmpdir(), "cognia-smoke-home-")),
    transcriptFs: memoryTranscript(),
  })
  try {
    const result = await session.send(prompt(cwd), {
      gate: createPermissionGate({
        prompt: async () => {
          approvalPrompts += 1
          return true
        },
      }),
      // The broker projects its tool calls as TUI actions; capture them here
      // instead of rendering, so the assertion is on what Cognia RECORDED.
      onAction: (action) => {
        if (action.type === "TOOL_CALL") observed.calls.push(action.toolName)
        if (action.type === "TOOL_RESULT") {
          observed.results.push({
            name: action.toolName,
            ok: !action.isError,
            summary: String(action.result ?? "").slice(0, 160),
          })
        }
      },
      timeoutMs: 300_000,
    })
    const parity = readToolHostStatus(session.sessionId)
    const wroteFile = fs.existsSync(path.join(cwd, "SMOKE.txt"))
    const sawRead = observed.results.some((r) => r.name === READ_TOOL && r.ok)
    const sawWrite = observed.results.some((r) => r.name === WRITE_TOOL && r.ok)
    const sawHostTool = observed.results.some((r) => r.name === HOST_TOOL && r.ok)
    const lines = [
      `  reply        ${JSON.stringify(result.text.slice(0, 60))}`,
      `  bridge       ${parity?.running ? "running" : "NOT RUNNING"} · ${parity?.builtinToolCount ?? 0} built-in · ${parity?.hostToolCount ?? 0} host`,
      `  tool calls   ${observed.calls.join(", ") || "(none)"}`,
      `  read-only    ${sawRead ? "OK" : "MISSING"} (${READ_TOOL})`,
      `  mutating     ${sawWrite ? "OK" : "MISSING"} (${WRITE_TOOL})`,
      `  host tool    ${sawHostTool ? "OK" : "MISSING"} (${HOST_TOOL})`,
      `  approvals    ${approvalPrompts} (expected exactly 1)`,
      `  git probe    ${
        observed.results.some((r) => r.name === PROBE_TOOL && r.ok)
          ? "OK"
          : "not usable under the launcher sandbox (reported, not gating)"
      }`,
      `  side effect  ${wroteFile ? "SMOKE.txt written" : "SMOKE.txt ABSENT"}`,
      ...observed.results.map((r) => `  · ${r.name} ${r.ok ? "ok" : "ERR"}: ${r.summary}`),
    ]
    // The mutating half is only proven by the file actually appearing: a tool
    // result Cognia recorded but that changed nothing would be the same silent
    // lie this work exists to remove.
    const ok = sawRead && sawWrite && sawHostTool && wroteFile && approvalPrompts === 1
    return { ok, detail: lines.join("\n") }
  } finally {
    unsubscribeAskUser()
    useAskUserStore.setState({ active: null, queue: [] })
    await session.close().catch(() => undefined)
    if (!process.argv.includes("--keep")) fs.rmSync(cwd, { recursive: true, force: true })
  }
}

async function main(): Promise<number> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"))
  const targets = (requested.length > 0 ? requested : BACKENDS) as Backend[]
  const root = repoRoot()
  let failures = 0
  for (const backend of targets) {
    process.stdout.write(`\n=== ${backend} ===\n`)
    try {
      const { ok, detail } = await runBackend(backend, root)
      process.stdout.write(`${detail}\n  RESULT       ${ok ? "PASS" : "FAIL"}\n`)
      if (!ok) failures += 1
    } catch (err) {
      failures += 1
      const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)
      process.stdout.write(`  RESULT       FAIL — ${detail}\n`)
      const data = (err as { data?: unknown })?.data
      if (data !== undefined) process.stdout.write(`  data         ${JSON.stringify(data)}\n`)
    }
  }
  process.stdout.write(
    `\n${failures === 0 ? "all backends PASS" : `${failures} backend(s) FAILED`}\n`
  )
  return failures === 0 ? 0 : 1
}

void main().then((code) => {
  process.exitCode = code
})
