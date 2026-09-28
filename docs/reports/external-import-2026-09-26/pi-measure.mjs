import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir, platform, arch, cpus } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"

const root = process.cwd()
const revision = "5d48f846142312c8d344083b5240d32400b36946"
const dir = await mkdtemp(join(tmpdir(), "cognia-pi-perf-"))
try {
  const require = createRequire(import.meta.url)
  const files = ["lib/session-import/adapters/pi.ts", "lib/session-import/adapters/pi-tree.ts"]
  const sha = (text) => createHash("sha256").update(text).digest("hex")
  const baseline = new Map(
    files.map((file) => [
      resolve(file),
      execFileSync("git", ["show", `${revision}:${file}`], { cwd: root, encoding: "utf8" }),
    ])
  )
  const modules = {}
  for (const variant of ["baseline", "candidate"]) {
    const outfile = join(dir, `${variant}.cjs`)
    await build({
      entryPoints: [files[0]],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      // Native filesystem APIs are never invoked by parsePiSession. Real Node
      // file I/O surrounds the unmodified production converter below.
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
                  builder.onLoad({ filter: /\/adapters\/pi(?:-tree)?\.ts$/ }, (args) => {
                    const contents = baseline.get(args.path)
                    return contents === undefined ? undefined : { contents, loader: "ts" }
                  })
                },
              },
            ]
          : []),
      ],
    })
    modules[variant] = require(outfile)
  }
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2
  }
  const summarize = (xs) => ({
    median: median(xs),
    mad: median(xs.map((x) => Math.abs(x - median(xs)))),
  })
  function fixture(branched) {
    const lines = [
      {
        type: "session",
        version: 3,
        id: "perf",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/fixture",
      },
    ]
    for (let i = 0; i < 12010; i++) {
      const parent =
        i === 0 ? null : branched && i >= 10 && (i - 10) % 12 === 0 ? "e9" : `e${i - 1}`
      lines.push({
        type: "message",
        id: `e${i}`,
        parentId: parent,
        timestamp: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        message: { role: i % 2 ? "assistant" : "user", content: "x".repeat(128) },
      })
    }
    return lines.map((line) => JSON.stringify(line)).join("\n")
  }
  const result = {
    revision,
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0].model,
    sourceHashes: {},
    workloads: {},
  }
  for (const file of files)
    result.sourceHashes[file] = {
      baseline: sha(baseline.get(resolve(file))),
      candidate: sha(await readFile(file)),
    }
  for (const name of ["branched", "linear"]) {
    const content = fixture(name === "branched")
    const path = join(dir, `${name}.jsonl`)
    await writeFile(path, content)
    const samples = { baseline: [], candidate: [] }
    let expectedHash
    for (let i = -2; i < 12; i++) {
      for (const variant of i % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        global.gc?.()
        const before = process.memoryUsage()
        const start = performance.now()
        const output = modules[variant].parsePiSession(
          { sourceId: "pi", originalSessionId: "perf", locator: path },
          await readFile(path, "utf8")
        )
        const ms = performance.now() - start
        const after = process.memoryUsage()
        const hash = sha(JSON.stringify(output))
        expectedHash ??= hash
        if (hash !== expectedHash) throw new Error(`${name} ${variant} output mismatch`)
        if (i >= 0)
          samples[variant].push({
            ms,
            heapDelta: after.heapUsed - before.heapUsed,
            rssDelta: after.rss - before.rss,
          })
      }
    }
    result.workloads[name] = {
      bytes: Buffer.byteLength(content),
      outputHash: expectedHash,
      samples,
      summary: Object.fromEntries(
        Object.entries(samples).map(([key, value]) => [key, summarize(value.map((x) => x.ms))])
      ),
    }
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(dir, { recursive: true, force: true })
}
