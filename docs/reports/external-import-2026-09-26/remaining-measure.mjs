import { build } from "esbuild"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir, stat, access } from "node:fs/promises"
import { tmpdir, platform, arch, cpus } from "node:os"
import { join, resolve, basename } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"
const report = "docs/reports/external-import-2026-09-26"
const dir = await mkdtemp(join(tmpdir(), "cognia-remaining-perf-"))
const require = createRequire(import.meta.url)
const sha = (x) => createHash("sha256").update(x).digest("hex")
const median = (xs) => {
  const a = [...xs].sort((a, b) => a - b)
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
}
const summary = (xs) => ({
  median: median(xs),
  mad: median(xs.map((x) => Math.abs(x - median(xs)))),
})
const result = {
  node: process.version,
  platform: platform(),
  arch: arch(),
  cpu: cpus()[0].model,
  sourceHashes: {},
  workloads: {},
}
const fs = {
  exists: async (p) => {
    try {
      await access(p)
      return true
    } catch {
      return false
    }
  },
  readDir: readdir,
  readDirEntries: async (p) =>
    (await readdir(p, { withFileTypes: true })).map((e) => ({ name: e.name, isFile: e.isFile() })),
  stat: async (p) => {
    const s = await stat(p)
    return { size: s.size, isFile: s.isFile() }
  },
  readTextFile: (p) => readFile(p, "utf8"),
}
try {
  const modules = {}
  for (const [source, exportName] of [
    ["gemini-cli", "geminiCliSessionSource"],
    ["continue-dev", "continueDevSessionSource"],
    ["aider", "aiderSessionSource"],
  ]) {
    const path = `lib/session-import/adapters/${source}.ts`
    const baseline = await readFile(`${report}/remaining-${source}-baseline.ts`, "utf8")
    result.sourceHashes[source] = { baseline: sha(baseline), candidate: sha(await readFile(path)) }
    modules[source] = {}
    for (const variant of ["baseline", "candidate"]) {
      const outfile = join(dir, `${source}-${variant}.cjs`)
      await build({
        entryPoints: [path],
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
            name: "host-boundary",
            setup(b) {
              b.onResolve({ filter: /^@\/lib\/cli-bridge\/home$/ }, (args) => ({
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
                  setup(b) {
                    b.onLoad({ filter: /\/adapters\/[^/]+\.ts$/ }, (args) =>
                      args.path === resolve(path) ? { contents: baseline, loader: "ts" } : undefined
                    )
                  },
                },
              ]
            : []),
        ],
      })
      modules[source][variant] = require(outfile)[exportName]
    }
  }
  const cases = [
    ["gemini-many", "gemini-cli", 500, 8, true],
    ["gemini-desktop", "gemini-cli", 2000, 8, false],
    ["gemini-rewind", "gemini-cli", 1, 20000, true],
    ["gemini-long", "gemini-cli", 1, 20000, true],
    ["gemini-small", "gemini-cli", 2, 8, true],
    ["gemini-tools", "gemini-cli", 1, 600, true],
    ["gemini-tools-pair", "gemini-cli", 2, 600, true],
    ["continue-many", "continue-dev", 2000, 8, false],
    ["continue-long", "continue-dev", 1, 20000, false],
    ["continue-small", "continue-dev", 2, 8, false],
    ["aider-scan", "aider", 1, 60000, false],
    ["aider-small", "aider", 1, 16, false],
    ["aider-full", "aider", 1, 60000, true],
  ]
  for (const [name, source, count, n, graphsEnabled] of cases.filter(
    ([name]) => !process.env.REMAINING_WORKLOAD || name.startsWith(process.env.REMAINING_WORKLOAD)
  )) {
    const home = join(dir, name),
      folder = join(
        home,
        source === "continue-dev"
          ? ".continue/sessions"
          : name === "gemini-desktop"
            ? ".gemini/tmp/chats"
            : "picked"
      )
    await mkdir(folder, { recursive: true })
    const paths = []
    let bytes = 0
    for (let i = 0; i < count; i++) {
      let content,
        ext = "json"
      if (source === "gemini-cli") {
        const stamp = "2026-01-01T00:00:00.000Z"
        const rows = [
          { sessionId: `s${i}`, projectHash: "fixture", startTime: stamp, lastUpdated: stamp },
        ]
        for (let j = 0; j < n; j++)
          rows.push({
            id: `m${j}`,
            timestamp: stamp,
            type: j % 2 ? "gemini" : "user",
            content: [{ text: "x".repeat(128) }],
          })
        if (name === "gemini-rewind")
          for (let j = 0; j < 1000; j++) {
            rows.push({ $rewindTo: `m${n - 1}` })
            rows.push({
              id: `m${n - 1}`,
              timestamp: stamp,
              type: "gemini",
              content: [{ text: "replacement" }],
            })
          }
        if (name.startsWith("gemini-tools"))
          for (const row of rows) {
            if (row.type === "gemini")
              row.toolCalls = [
                {
                  id: `tool-${row.id}`,
                  name: "shell",
                  args: { command: "fixture" },
                  result: "z".repeat(16 * 1024),
                  status: "success",
                },
              ]
          }
        content = rows.map((r) => JSON.stringify(r)).join("\n")
        ext = "jsonl"
      } else if (source === "continue-dev") {
        content = JSON.stringify({
          sessionId: `s${i}`,
          title: "fixture",
          history: Array.from({ length: n }, (_, j) => ({
            message: { role: j % 2 ? "assistant" : "user", content: "x".repeat(128) },
          })),
        })
      } else {
        content =
          "# aider chat started at 2026-01-01 00:00:00\n" +
          Array.from({ length: n }, (_, j) => (j % 2 ? "" : "#### ") + "x".repeat(128)).join("\n")
        ext = "md"
      }
      const path = join(folder, `session-${String(i).padStart(5, "0")}.${ext}`)
      await writeFile(path, content)
      paths.push(path)
      bytes += Buffer.byteLength(content)
    }
    const samples = { baseline: [], candidate: [] }
    let expected
    for (let iteration = -2; iteration < 12; iteration++)
      for (const variant of iteration % 2 === 0
        ? ["baseline", "candidate"]
        : ["candidate", "baseline"]) {
        global.gc?.()
        const before = process.memoryUsage()
        const start = performance.now()
        const input = { fs, home }
        if (source !== "continue-dev" && name !== "gemini-desktop")
          input.pickedFiles = await Promise.all(
            paths.map(async (path) => ({
              path,
              name: basename(path),
              content: await readFile(path, "utf8"),
            }))
          )
        const adapter = modules[source][variant]
        const list = await adapter.listSessions(input),
          scanMs = performance.now() - start
        const graphs = []
        if (graphsEnabled)
          for (const item of list) graphs.push(await adapter.parseGraph(item.ref, input))
        const ms = performance.now() - start,
          after = process.memoryUsage()
        const hash = sha(JSON.stringify({ list, graphs }).split(home).join("/fixture"))
        expected ??= hash
        if (hash !== expected)
          throw Error(`${name} ${variant} output differs ${hash} vs ${expected}`)
        if (list.length !== count || list.reduce((s, x) => s + x.messageCount, 0) !== count * n)
          throw Error(`${name} missing messages`)
        global.gc?.()
        const retained = process.memoryUsage().heapUsed - before.heapUsed
        if (iteration >= 0)
          samples[variant].push({
            ms,
            scanMs,
            heapDelta: after.heapUsed - before.heapUsed,
            rssDelta: after.rss - before.rss,
            retained,
          })
      }
    result.workloads[name] = {
      source,
      count,
      messages: n,
      bytes,
      graphsEnabled,
      outputHash: expected,
      samples,
      summary: Object.fromEntries(
        Object.entries(samples).map(([v, x]) => [v, summary(x.map((s) => s.ms))])
      ),
    }
    process.stderr.write(`${name} ${JSON.stringify(result.workloads[name].summary)}\n`)
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(dir, { recursive: true, force: true })
}
