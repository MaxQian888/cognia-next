import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, stat, access } from "node:fs/promises"
import { tmpdir, platform, arch, cpus } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"

const root = process.cwd()
const revision = "10c36223d479a08efe918e7035f1c14a42ed3534"
const source = "lib/session-import/adapters/codex.ts"
const dir = await mkdtemp(join(tmpdir(), "cognia-codex-perf-"))
try {
  const require = createRequire(import.meta.url)
  const sha = (text) => createHash("sha256").update(text).digest("hex")
  const baseline = execFileSync("git", ["show", `${revision}:${source}`], {
    cwd: root,
    encoding: "utf8",
  })
  const modules = {}
  for (const variant of ["baseline", "candidate"]) {
    const outfile = join(dir, `${variant}.cjs`)
    await build({
      entryPoints: [source],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: [
        "@/lib/file/file-operations",
        "@/lib/chat/media/normalize-message-media",
        "@/lib/claude/ipc",
        "@/lib/ai/generation/summarize-material",
      ],
      plugins: [
        {
          name: "unused-host-boundary",
          setup(builder) {
            builder.onResolve({ filter: /^@\/lib\/cli-bridge\/home$/ }, (args) => ({
              path: args.path,
              external: true,
              sideEffects: false,
            }))
          },
        },
        ...(variant === "baseline"
          ? [
              {
                name: "baseline",
                setup(builder) {
                  builder.onLoad({ filter: /\/adapters\/codex\.ts$/ }, (args) =>
                    args.path === resolve(source) ? { contents: baseline, loader: "ts" } : undefined
                  )
                },
              },
            ]
          : []),
      ],
    })
    modules[variant] = require(outfile).codexSessionSource
  }
  const fs = {
    exists: async (path) => {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
    readDir: (path) => readdir(path),
    readDirEntries: async (path) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
      })),
    stat: async (path) => {
      const info = await stat(path)
      return { size: info.size, isFile: info.isFile() }
    },
    readTextFile: (path) => readFile(path, "utf8"),
  }
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2
  }
  const summarize = (xs) => ({
    median: median(xs),
    mad: median(xs.map((x) => Math.abs(x - median(xs)))),
  })
  const result = {
    revision,
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0].model,
    sourceHashes: { baseline: sha(baseline), candidate: sha(await readFile(source)) },
    workloads: {},
  }
  for (const [name, sessions, messages] of [
    ["many-sessions", 2500, 8],
    ["long-history", 1, 20000],
    ["small", 2, 8],
  ]) {
    const home = join(dir, name)
    const folder = join(home, ".codex/sessions")
    await mkdir(folder, { recursive: true })
    let bytes = 0
    for (let i = 0; i < sessions; i++) {
      const timestamp = "2026-01-01T00:00:00.000Z"
      const lines = [
        {
          timestamp,
          type: "session_meta",
          payload: { id: `s${i}`, cwd: "/fixture", cli_version: "0.150.1" },
        },
      ]
      for (let j = 0; j < messages; j++)
        lines.push({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: j % 2 ? "assistant" : "user",
            content: [{ type: j % 2 ? "output_text" : "input_text", text: "x".repeat(128) }],
          },
        })
      const content = lines.map((line) => JSON.stringify(line)).join("\n")
      bytes += Buffer.byteLength(content)
      await writeFile(join(folder, `rollout-${String(i).padStart(5, "0")}.jsonl`), content)
    }
    const samples = { baseline: [], candidate: [] }
    let expectedHash
    for (let i = -2; i < 12; i++) {
      for (const variant of i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        global.gc?.()
        const input = { fs, home }
        const before = process.memoryUsage()
        const start = performance.now()
        const list = await modules[variant].listSessions(input)
        const scanMs = performance.now() - start
        const graphs = []
        for (const summary of list)
          graphs.push(await modules[variant].parseGraph(summary.ref, input))
        const ms = performance.now() - start
        const after = process.memoryUsage()
        const hash = sha(JSON.stringify({ list, graphs }))
        expectedHash ??= hash
        if (hash !== expectedHash) throw new Error(`${name} ${variant} output mismatch`)
        if (
          list.length !== sessions ||
          graphs.reduce((n, g) => n + g.nodes[0].conversation.messages.length, 0) !==
            sessions * messages
        )
          throw new Error("fixture lost messages")
        if (i >= 0)
          samples[variant].push({
            ms,
            scanMs,
            heapDelta: after.heapUsed - before.heapUsed,
            rssDelta: after.rss - before.rss,
          })
      }
    }
    result.workloads[name] = {
      sessions,
      messages,
      bytes,
      outputHash: expectedHash,
      samples,
      summary: Object.fromEntries(
        Object.entries(samples).map(([key, values]) => [
          key,
          summarize(values.map((value) => value.ms)),
        ])
      ),
    }
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(dir, { recursive: true, force: true })
}
