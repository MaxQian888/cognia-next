import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./verify-motion.mjs", import.meta.url))

function run(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

async function createMockMediaTools(root) {
  const bin = path.join(root, "bin")
  await mkdir(bin)
  const ffprobe = path.join(bin, "ffprobe")
  const ffmpeg = path.join(bin, "ffmpeg")
  await writeFile(
    ffprobe,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
process.stdout.write(args.some((arg) => arg.includes("format=duration")) ? "1\\n" : "100,100\\n")
`
  )
  await writeFile(
    ffmpeg,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args.includes("-lavfi")) {
  process.stderr.write(process.env.MOCK_PSNR || "average:30.0\\n")
} else {
  writeFileSync(args.at(-1), "fixture")
}
`
  )
  await Promise.all([chmod(ffprobe, 0o755), chmod(ffmpeg, 0o755)])
  return bin
}

test("documents the Figma motion fidelity gate", async () => {
  const result = await run(["--help"])

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /verify-motion\.mjs/)
  assert.match(result.stdout, /--reference/)
  assert.match(result.stdout, /--min-motion-psnr/)
})

test("rejects a non-positive sampling interval before reading video files", async () => {
  const result = await run([
    "--reference",
    "reference.mp4",
    "--render",
    "render.mp4",
    "--interval",
    "0",
  ])

  assert.equal(result.code, 2)
  assert.match(result.stderr, /interval.*greater than 0/i)
})

test("fails preflight instead of passing when FFmpeg does not return a PSNR score", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-motion-cli-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = await createMockMediaTools(root)
  const reference = path.join(root, "reference.mp4")
  const render = path.join(root, "render.mp4")
  await Promise.all([writeFile(reference, "fixture"), writeFile(render, "fixture")])

  const result = await run(["--reference", reference, "--render", render], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    MOCK_PSNR: "no psnr stats\\n",
  })

  assert.equal(result.code, 3)
  assert.match(result.stderr, /did not report a PSNR average/i)
})

test("reports a failed verification when FFmpeg returns a zero PSNR score", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-motion-cli-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = await createMockMediaTools(root)
  const reference = path.join(root, "reference.mp4")
  const render = path.join(root, "render.mp4")
  await Promise.all([writeFile(reference, "fixture"), writeFile(render, "fixture")])

  const result = await run(["--reference", reference, "--render", render], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    MOCK_PSNR: "average:0\\n",
  })

  assert.equal(result.code, 1)
  assert.match(result.stdout, /min-motion=0\.00dB/)
  assert.match(result.stdout, /VERDICT: FAIL/)
})

test("reports a pass with the selected sampling interval", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "figma-motion-cli-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = await createMockMediaTools(root)
  const reference = path.join(root, "reference.mp4")
  const render = path.join(root, "render.mp4")
  await Promise.all([writeFile(reference, "fixture"), writeFile(render, "fixture")])

  const result = await run(["--reference", reference, "--render", render, "--interval", "0.25"], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  })

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /window 0\.00s→0\.25s/)
  assert.match(result.stdout, /windows=3 min-motion=30\.00dB/)
  assert.match(result.stdout, /VERDICT: PASS/)
})
