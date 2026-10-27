import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import {
  parseBenchmarkArgs,
  HELP,
  main,
  verifyFrozenRuntime,
  captureBenchmarkBuild,
} from "./multiagentbench.mjs"
import { loadEsbuild } from "../build/esbuild-shared.mjs"

test("accepts a fixed balanced protocol and supports the pnpm separator", () => {
  const value = parseBenchmarkArgs([
    "--",
    "--cases",
    "4",
    "--repetitions",
    "3",
    "--dry-run",
    "--offline",
  ])
  assert.equal(value.cases, 4)
  assert.equal(value.repetitions, 3)
  assert.equal(value.dryRun, true)
  assert.equal(value.offline, true)
  assert.equal(value.model, "ark-deepseek-v4.1-flash")
  assert.equal(value.judgeModel, value.model)
  assert.equal(value.reasoningEffort, "low")
  assert.equal(value.maxSolverOutputTokens, 8192)
  assert.equal(
    parseBenchmarkArgs(["--judge-max-output-tokens", "16384"]).maxJudgeOutputTokens,
    16384
  )
  assert.equal(value.judgeTimeoutMs, 60000)
  assert.equal(parseBenchmarkArgs(["--judge-timeout-ms", "180000"]).judgeTimeoutMs, 180000)
  assert.deepEqual(parseBenchmarkArgs(["--task-ids", "2,7"]).taskIds, ["2", "7"])
  assert.match(HELP, /external literature tools are disabled/)
})
test("rejects invalid resource bounds and unknown flags before building", () => {
  for (const args of [
    ["--cases", "0"],
    ["--cases", "101"],
    ["--repetitions", "1.5"],
    ["--timeout-ms", "Infinity"],
    ["--judge-timeout-ms", "0"],
    ["--judge-timeout-ms", "3600001"],
    ["--seed", "-1"],
    ["--model", "secret\nvalue"],
    ["--bogus"],
    ["--reasoning-effort", "none"],
    ["--max-output-tokens", "0"],
    ["--judge-max-output-tokens", "16385"],
    ["--task-ids", "2,2"],
    ["--task-ids", "2,"],
  ])
    assert.throws(() => parseBenchmarkArgs(args))
})

test("resumes only a frozen run and rejects protocol overrides", () => {
  const options = parseBenchmarkArgs(["--resume", ".cache/prior-run"])
  assert.equal(options.resumeDir, path.resolve(".cache/prior-run"))
  assert.throws(() => parseBenchmarkArgs(["--resume", ".cache/prior-run", "--model", "other"]))
  assert.throws(() => parseBenchmarkArgs(["--resume", ".cache/prior-run", "--dry-run"]))
  assert.equal(parseBenchmarkArgs(["--diagnostics", "primary"]).diagnostics, "primary")
  assert.equal(
    parseBenchmarkArgs(["--diagnostics", "sampled", "--diagnostic-every", "10"]).diagnosticEvery,
    10
  )
  assert.throws(() => parseBenchmarkArgs(["--diagnostics", "unknown"]))
})

test("verifies frozen outputs before importing or building on resume", async () => {
  const dir = await fs.mkdtemp(path.resolve(".cache/multiagentbench-frozen-test-"))
  const entry = path.join(dir, "runtime/multiagentbench.mjs")
  const bytes =
    'import fs from "node:fs/promises"; import path from "node:path"; export async function resumeBenchmark(dir, retry) { await fs.writeFile(path.join(dir,"resumed"), JSON.stringify({retry})); return 0 }'
  const source = {
    outputs: [{ path: entry, sha256: createHash("sha256").update(bytes).digest("hex") }],
  }
  const save = async () => {
    await fs.writeFile(path.join(dir, "source-manifest.json"), JSON.stringify(source))
    await fs.writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({ schema: "cognia.multiagentbench-research/v3", sourceManifest: source })
    )
  }
  try {
    await fs.mkdir(path.dirname(entry))
    await fs.writeFile(entry, bytes)
    await save()
    assert.equal(await verifyFrozenRuntime(dir), entry)
    let builds = 0
    await main(["--resume", dir, "--retry-interrupted"], async () => {
      builds++
      throw Error("must not build")
    })
    assert.equal(builds, 0)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "resumed"), "utf8")), {
      retry: true,
    })
    await fs.writeFile(entry, "tampered")
    await assert.rejects(verifyFrozenRuntime(dir), /checksum/)
    await fs.unlink(entry)
    await assert.rejects(verifyFrozenRuntime(dir), /ENOENT/)
    await fs.mkdir(entry)
    await assert.rejects(verifyFrozenRuntime(dir), /checksum/)
    await fs.rmdir(entry)
    await fs.writeFile(entry, bytes)
    source.outputs.push(source.outputs[0])
    await save()
    await assert.rejects(verifyFrozenRuntime(dir), /path is invalid/)
    source.outputs.pop()
    source.outputs[0] = { ...source.outputs[0], path: path.resolve("package.json") }
    await save()
    await assert.rejects(verifyFrozenRuntime(dir), /path is invalid/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("captures actual compiler input bytes even when sources change after loading", async () => {
  const dir = await fs.mkdtemp(path.resolve(".cache/multiagentbench-input-test-"))
  const file = path.join(dir, "fixture.ts")
  const original = "export const compiled = 1"
  const transformed = "export const compiled = 2"
  const builder = await loadEsbuild()
  try {
    await fs.writeFile(file, original)
    for (const plugin of [
      undefined,
      {
        name: "fixture-transform",
        setup(build) {
          build.onLoad({ filter: /fixture\.ts$/ }, () => ({ contents: transformed, loader: "ts" }))
        },
      },
    ]) {
      const captured = captureBenchmarkBuild({
        entryPoints: [file],
        outfile: path.join(dir, "output.mjs"),
        bundle: true,
        format: "esm",
        plugins: plugin ? [plugin] : [],
      })
      await builder.build({ ...captured.options, metafile: true })
      const input = captured.inputs.get(path.relative(process.cwd(), file))
      assert.equal(
        input.sha256,
        createHash("sha256")
          .update(plugin ? transformed : original)
          .digest("hex")
      )
      assert.equal(input.contentKind, plugin ? "plugin-output" : "source-bytes")
    }
    await fs.writeFile(file, "export const compiled = 999")
    // Captured bytes are independent of the now-mutated live tree.
    assert.match(await fs.readFile(path.join(dir, "output.mjs"), "utf8"), /compiled = 2/)
  } finally {
    builder.stop()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("releases the build worker before evaluation and after a failed build", async (t) => {
  for (const fail of [false, true]) {
    await t.test(fail ? "failed build" : "before evaluation", async () => {
      const dir = await fs.mkdtemp(path.resolve(".cache/multiagentbench-worker-test-"))
      const runDir = path.join(dir, "run")
      let stopped = 0
      let outdir
      try {
        const run = main(["--dry-run", "--run-dir", runDir], async () => ({
          async build(options) {
            outdir = options.outdir
            if (fail) throw new Error("planned build failure")
            await fs.mkdir(outdir, { recursive: true })
            await fs.writeFile(
              path.join(outdir, "multiagentbench.mjs"),
              'import fs from "node:fs"; export async function runBenchmark() { if (!fs.existsSync(new URL("./worker-released", import.meta.url))) throw new Error("build worker still retained"); return 0 }'
            )
            return { metafile: { inputs: {}, outputs: {} } }
          },
          stop() {
            stopped++
            if (!fail) writeFileSync(path.join(outdir, "worker-released"), "released")
          },
        }))
        if (fail) await assert.rejects(run, /planned build failure/)
        else await run
        assert.equal(stopped, 1)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  }
})
