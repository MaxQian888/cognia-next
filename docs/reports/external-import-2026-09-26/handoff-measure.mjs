import { build } from "esbuild"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"

const report = new URL("./", import.meta.url)
const source = "lib/session-import/adapters/claude-code.ts"
const adapterSource = await readFile(new URL("handoff-claude-snapshot.ts", report), "utf8")
const baseline = await readFile(new URL("handoff-baseline.ts", report), "utf8")
const candidate = await readFile("lib/chat/handoff-context.ts", "utf8")
const scratch = await mkdtemp(join(tmpdir(), "cognia-handoff-perf-"))
const sha = (text) => createHash("sha256").update(text).digest("hex")
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y)
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
}
const stats = (a) => {
  const m = median(a)
  return { median: m, mad: median(a.map((x) => Math.abs(x - m))) }
}
const fs = {
  async exists(path) {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  async readDir(path) {
    return (await readdir(path)).sort()
  },
  async readDirEntries(path) {
    return (await readdir(path, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, isFile: e.isFile() }))
  },
  async stat(path) {
    const s = await stat(path)
    return { size: s.size, isFile: s.isFile() }
  },
  async readTextFile(path) {
    return readFile(path, "utf8")
  },
}
const modules = {}
const profileOnly = process.argv.includes("--profile-only")
try {
  for (const variant of profileOnly ? ["profile"] : ["baseline", "candidate"]) {
    let handoff = variant === "candidate" ? candidate : baseline
    if (variant === "profile") {
      handoff = handoff.replace(
        "export function buildHandoffContext(",
        "function buildHandoffContextImpl("
      )
      handoff += `\nexport function buildHandoffContext(...args: Parameters<typeof buildHandoffContextImpl>) { const start=performance.now(); try { return buildHandoffContextImpl(...args) } finally { globalThis.__handoffMetrics.push(performance.now()-start) } }\n`
    }
    const outfile = join(scratch, `${variant}.cjs`)
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
          name: "snapshot-source-and-handoff",
          setup(builder) {
            builder.onResolve({ filter: /^@\/lib\/cli-bridge\/home$/ }, (args) => ({
              path: args.path,
              external: true,
              sideEffects: false,
            }))
            builder.onLoad({ filter: /\/adapters\/claude-code\.ts$/ }, () => ({
              contents: adapterSource,
              loader: "ts",
            }))
            builder.onLoad({ filter: /\/lib\/chat\/handoff-context\.ts$/ }, () => ({
              contents: handoff,
              loader: "ts",
            }))
          },
        },
      ],
    })
    modules[variant] = createRequire(import.meta.url)(outfile).claudeCodeSessionSource
  }
  const result = {
    node: process.version,
    cpu: cpus()[0].model,
    hashes: { adapter: sha(adapterSource), baseline: sha(baseline), candidate: sha(candidate) },
    workloads: {},
  }
  for (const [name, count, toolBytes] of [
    ["large-tools", 1800, 16384],
    ["huge-tools", 300, 524288],
    ["small", 20, 0],
  ]) {
    const home = join(scratch, name),
      path = join(home, ".claude/projects/project/session.jsonl")
    await mkdir(dirname(path), { recursive: true })
    const records = []
    for (let i = 0; i < count; i++) {
      const common = {
        uuid: `r${i}`,
        parentUuid: i ? `r${i - 1}` : null,
        sessionId: "session",
        cwd: "/fixture",
        timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      }
      const message =
        i % 3 === 2 && toolBytes
          ? {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: `call${i - 1}`,
                    content: "x".repeat(toolBytes),
                  },
                ],
              },
            }
          : i % 3 === 1
            ? {
                type: "assistant",
                message: {
                  content: [
                    { type: "thinking", thinking: "Inspect state" },
                    { type: "text", text: "Reading source" },
                    {
                      type: "tool_use",
                      id: `call${i}`,
                      name: "Read",
                      input: { path: "/fixture/source.ts" },
                    },
                  ],
                },
              }
            : { type: "user", message: { content: "Investigate only; never modify production." } }
      records.push({ ...common, ...message })
    }
    const fileText =
      records.map(JSON.stringify).join("\n") + (toolBytes ? '\n{"type":"user","unfinished"' : "")
    await writeFile(path, fileText)
    records.length = 0
    const ref = { sourceId: "claude-code", originalSessionId: "session", locator: path }
    if (profileOnly) {
      for (let i = 0; i < 3; i++) {
        globalThis.__handoffMetrics = []
        global.gc?.()
        const start = performance.now()
        await modules.profile.parseGraph(ref, { fs, home })
        const totalMs = performance.now() - start
        if (i === 2)
          result.workloads[name] = {
            bytes: Buffer.byteLength(fileText),
            totalMs,
            handoffCalls: globalThis.__handoffMetrics.length,
            handoffMs: globalThis.__handoffMetrics.reduce((a, b) => a + b, 0),
          }
      }
      continue
    }
    const samples = { baseline: [], candidate: [] }
    let expectedHash
    for (let i = -2; i < 12; i++) {
      for (const variant of i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        await new Promise(setImmediate)
        global.gc?.()
        const before = process.memoryUsage(),
          start = performance.now()
        let graph = await modules[variant].parseGraph(ref, { fs, home })
        const ms = performance.now() - start,
          transient = process.memoryUsage()
        global.gc?.()
        const retained = process.memoryUsage()
        const outputHash = sha(JSON.stringify(graph))
        expectedHash ??= outputHash
        if (outputHash !== expectedHash) throw new Error(`${name} ${variant} output mismatch`)
        if (i >= 0)
          samples[variant].push({
            ms,
            heapDelta: transient.heapUsed - before.heapUsed,
            retainedHeapDelta: retained.heapUsed - before.heapUsed,
            rssDelta: transient.rss - before.rss,
          })
        graph = null
      }
    }
    result.workloads[name] = {
      bytes: Buffer.byteLength(fileText),
      outputHash: expectedHash,
      samples,
      summary: Object.fromEntries(
        Object.entries(samples).map(([v, a]) => [
          v,
          {
            timeMs: stats(a.map((x) => x.ms)),
            heapDelta: stats(a.map((x) => x.heapDelta)),
            retainedHeapDelta: stats(a.map((x) => x.retainedHeapDelta)),
          },
        ])
      ),
    }
    process.stderr.write(`${name}: ${JSON.stringify(result.workloads[name].summary)}\n`)
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(scratch, { recursive: true, force: true })
}
