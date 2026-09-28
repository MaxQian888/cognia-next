import { build } from "esbuild"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"

const source = "lib/session-import/adapters/opencode.ts"
const report = new URL("./", import.meta.url)
const baseline = await readFile(new URL("opencode-baseline.ts", report), "utf8")
const candidate = await readFile(source, "utf8")
const scratch = await mkdtemp(join(tmpdir(), "cognia-opencode-perf-"))
const sha = (s) => createHash("sha256").update(s).digest("hex")
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y)
  return (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
}
const stats = (xs) => {
  const m = median(xs)
  return { median: m, mad: median(xs.map((x) => Math.abs(x - m))) }
}
const unusedFs = {
  exists: async () => false,
  readDir: async () => [],
  readTextFile: async () => {
    throw new Error("picker should use selected content")
  },
}
try {
  const modules = {}
  for (const variant of ["baseline", "candidate"]) {
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
        "@tauri-apps/api/core",
      ],
      plugins: [
        {
          name: "snapshot-and-unused-host",
          setup(builder) {
            builder.onResolve({ filter: /^@\/lib\/cli-bridge\/home$/ }, (args) => ({
              path: args.path,
              external: true,
              sideEffects: false,
            }))
            builder.onResolve({ filter: /^@\/lib\/tauri$/ }, () => ({
              path: "unused-tauri",
              namespace: "fixture",
            }))
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: "export const isTauri=()=>false",
              loader: "js",
            }))
            builder.onLoad({ filter: /\/adapters\/opencode\.ts$/ }, () => ({
              contents: variant === "baseline" ? baseline : candidate,
              loader: "ts",
            }))
          },
        },
      ],
    })
    modules[variant] = createRequire(import.meta.url)(outfile).opencodeSessionSource
  }
  const result = {
    node: process.version,
    cpu: cpus()[0].model,
    hashes: { baseline: sha(baseline), candidate: sha(candidate) },
    workloads: {},
  }
  for (const [name, count, selected, messages, toolBytes] of [
    ["batch", 10000, 128, 2, 0],
    ["single", 10000, 1, 2, 0],
    ["small", 4, 1, 2, 0],
    ["large-tools", 1, 1, 600, 32768],
  ]) {
    if (process.env.OPENCODE_WORKLOAD && process.env.OPENCODE_WORKLOAD !== name) continue
    const path = join(scratch, `${name}.json`),
      records = []
    for (let i = 0; i < count; i++) {
      const id = `s${i}`,
        parent = count > 1 && i % 4 ? `s${i - (i % 4)}` : undefined
      records.push({
        key: `session/${id}`,
        content: {
          id,
          title: `Session ${i}`,
          directory: "/fixture",
          parentID: parent,
          time: { created: 1000 + i, updated: 2000 + i },
        },
      })
      for (let j = 0; j < messages; j++) {
        const mid = `${id}-m${j}`
        records.push({
          key: `message/${mid}`,
          content: {
            id: mid,
            sessionID: id,
            role: j % 2 ? "assistant" : "user",
            time: { created: 1000 + i + j },
            modelID: "fixture-model",
            tokens: { input: 10, output: 20, cache: { read: 2, write: 1 } },
          },
        })
        const part =
          toolBytes && j % 2
            ? {
                type: "tool",
                tool: "read",
                callID: `call-${mid}`,
                state: {
                  status: "completed",
                  input: { path: "/fixture/file" },
                  output: "x".repeat(toolBytes),
                },
              }
            : {
                type: "text",
                text:
                  j % 2
                    ? "Read-only investigation complete."
                    : "Investigate only; preserve production.",
              }
        records.push({
          key: `part/${mid}`,
          content: { id: `part-${mid}`, messageID: mid, ...part },
        })
      }
    }
    const text = JSON.stringify(records),
      bytes = Buffer.byteLength(text)
    await writeFile(path, text)
    records.length = 0
    const samples = { baseline: [], candidate: [] }
    let expectedHash
    for (let iteration = -2; iteration < 12; iteration++) {
      for (const variant of iteration % 2 === 0
        ? ["baseline", "candidate"]
        : ["candidate", "baseline"]) {
        await new Promise(setImmediate)
        global.gc?.()
        const before = process.memoryUsage(),
          start = performance.now()
        let input = {
          home: "",
          fs: unusedFs,
          pickedFiles: [{ name: `${name}.json`, path, content: await readFile(path, "utf8") }],
        }
        let list = await modules[variant].listSessions(input),
          graphs = []
        for (const summary of list.slice(0, selected))
          graphs.push(await modules[variant].parseGraph(summary.ref, input))
        const ms = performance.now() - start,
          transient = process.memoryUsage()
        global.gc?.()
        const retained = process.memoryUsage()
        const outputHash = sha(JSON.stringify({ list, graphs }))
        expectedHash ??= outputHash
        if (outputHash !== expectedHash) throw new Error(`${name} ${variant} output mismatch`)
        if (iteration >= 0)
          samples[variant].push({
            ms,
            heapDelta: transient.heapUsed - before.heapUsed,
            retainedHeapDelta: retained.heapUsed - before.heapUsed,
            rssDelta: transient.rss - before.rss,
          })
        input = null
        list = null
        graphs = null
      }
    }
    result.workloads[name] = {
      bytes,
      sessionCount: count,
      selectedRootCount: selected,
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
