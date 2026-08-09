#!/usr/bin/env node
/**
 * Objective fidelity gate for Figma Motion imports (skill step 2b).
 *
 * Compares the HyperFrames render against Figma's `export_video` output
 * using motion-energy deltas. Static import divergence (fonts, rasterized
 * edges, and subpixel geometry) cancels out of both deltas, so the score
 * isolates choreography: trajectories, timing, and easing.
 *
 * Calibration (SDS "Unlocked" card, 2026-07): a faithful translation scored
 * min 20.3dB / mean 27.7dB; a diverging one (invented retract keyframes,
 * wrong durations) scored min 5.0dB / mean 23.1dB. The default threshold of
 * 15dB sits between with margin on both sides.
 *
 * --crop selects the card region inside the (usually larger) composition
 * frame. Measure it from the render (the card's left/top edge and scaled
 * size), rather than guessing: a wrong crop reads as motion divergence.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command, CommanderError } from "commander"
import { execa } from "execa"
import { z } from "zod"

const EXIT_USAGE = 2
const EXIT_PREFLIGHT = 3
const DEFAULT_INTERVAL_SECONDS = 0.2
const DEFAULT_MIN_MOTION_PSNR = 15

class UsageError extends Error {}
class PreflightError extends Error {}

const positiveNumber = (option) =>
  z
    .coerce.number({ error: `${option} must be a number greater than 0` })
    .finite(`${option} must be a finite number greater than 0`)
    .gt(0, `${option} must be greater than 0`)

const cliOptionsSchema = z.object({
  crop: z
    .string()
    .regex(/^\d+x\d+\+\d+\+\d+$/, "--crop must use WxH+X+Y, for example 1280x720+40+80")
    .optional(),
  interval: positiveNumber("--interval"),
  minMotionPsnr: positiveNumber("--min-motion-psnr"),
  reference: z.string().trim().min(1, "--reference must not be empty"),
  render: z.string().trim().min(1, "--render must not be empty"),
})

function createProgram() {
  return new Command()
    .name("node .agents/skills/figma/scripts/verify-motion.mjs")
    .description("Compare a HyperFrames motion render with Figma's export_video reference.")
    .configureHelp({ helpWidth: 120 })
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .requiredOption("--reference <path>", "Figma export_video MP4 used as the motion reference.")
    .requiredOption("--render <path>", "HyperFrames MP4 to validate.")
    .option("--crop <WxH+X+Y>", "Render crop measured from the actual card edges.")
    .option("--interval <seconds>", "Sampling interval in seconds.", String(DEFAULT_INTERVAL_SECONDS))
    .option(
      "--min-motion-psnr <decibels>",
      "Minimum acceptable motion-energy PSNR.",
      String(DEFAULT_MIN_MOTION_PSNR)
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  node .agents/skills/figma/scripts/verify-motion.mjs --reference figma.mp4 --render out.mp4\n" +
        "  node .agents/skills/figma/scripts/verify-motion.mjs --reference figma.mp4 --render out.mp4 --crop 1280x720+40+80\n"
    )
}

function parseCli(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    if (error instanceof CommanderError) throw new UsageError(error.message)
    throw error
  }
  const result = cliOptionsSchema.safeParse(program.opts())
  if (!result.success) throw new UsageError(result.error.issues[0].message)
  return result.data
}

function commandFailure(label, result) {
  const status = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`
  const output = result.all?.trim()
  return new PreflightError(`${label} failed with ${status}${output ? `: ${output}` : ""}`)
}

async function runTool(command, args, label) {
  let result
  try {
    result = await execa(command, args, { all: true, reject: false })
  } catch (error) {
    throw new PreflightError(`${label} could not start: ${error.message}`)
  }
  if (result.exitCode !== 0 || result.signal) throw commandFailure(label, result)
  return result
}

function readPositiveNumber(value, label) {
  const number = Number(value.trim())
  if (!Number.isFinite(number) || number <= 0) {
    throw new PreflightError(`${label} did not report a positive finite value`)
  }
  return number
}

function readNonNegativeNumber(value, label) {
  const number = Number(value.trim())
  if (!Number.isFinite(number) || number < 0) {
    throw new PreflightError(`${label} did not report a non-negative finite value`)
  }
  return number
}

async function readDuration(file) {
  const result = await runTool(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    `ffprobe duration for ${file}`
  )
  return readPositiveNumber(result.stdout, `ffprobe duration for ${file}`)
}

async function readDimensions(file) {
  const result = await runTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ],
    `ffprobe dimensions for ${file}`
  )
  const [width, height] = result.stdout.trim().split(",").map(Number)
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new PreflightError(`ffprobe dimensions for ${file} did not report positive integer dimensions`)
  }
  return { width, height }
}

async function extractFrame(source, time, filter, destination) {
  const args = ["-y", "-v", "error", "-ss", String(time), "-i", source, "-frames:v", "1"]
  if (filter) args.push("-vf", filter)
  args.push(destination)
  await runTool("ffmpeg", args, `ffmpeg frame extraction at ${time}s`)
}

async function difference(left, right, destination) {
  await runTool(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      left,
      "-i",
      right,
      "-filter_complex",
      "blend=all_mode=difference",
      destination,
    ],
    "ffmpeg motion-energy difference"
  )
}

async function measurePsnr(reference, render) {
  const result = await runTool(
    "ffmpeg",
    ["-i", reference, "-i", render, "-lavfi", "psnr", "-f", "null", "-"],
    "ffmpeg PSNR measurement"
  )
  const average = result.all.match(/average:\s*([\d.]+|inf)/i)?.[1]
  if (!average) throw new PreflightError("ffmpeg PSNR measurement did not report a PSNR average")
  return average.toLowerCase() === "inf" ? 99 : readNonNegativeNumber(average, "ffmpeg PSNR measurement")
}

function cropFilter(crop, dimensions) {
  if (!crop) return `scale=${dimensions.width}:${dimensions.height}`
  const [, width, height, x, y] = crop.match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/)
  return `crop=${width}:${height}:${x}:${y},scale=${dimensions.width}:${dimensions.height}`
}

function sampleTimes(end, interval) {
  const times = []
  for (let index = 0; ; index += 1) {
    const time = Number((index * interval).toFixed(6))
    if (time > end) break
    times.push(time)
  }
  if (times.length === 0) {
    throw new PreflightError("reference and render videos must be longer than the sampling interval")
  }
  return times
}

async function verifyMotion(options) {
  const [referenceDuration, renderDuration, referenceDimensions] = await Promise.all([
    readDuration(options.reference),
    readDuration(options.render),
    readDimensions(options.reference),
  ])
  const end = Math.min(referenceDuration, renderDuration) - options.interval - 0.01
  const times = sampleTimes(end, options.interval)
  const renderFilter = cropFilter(options.crop, referenceDimensions)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "verify-motion-"))
  const results = []

  try {
    for (const time of times) {
      const nextTime = Number((time + options.interval).toFixed(6))
      const paths = {
        referenceA: join(temporaryDirectory, "reference-a.png"),
        referenceB: join(temporaryDirectory, "reference-b.png"),
        referenceDelta: join(temporaryDirectory, "reference-delta.png"),
        renderA: join(temporaryDirectory, "render-a.png"),
        renderB: join(temporaryDirectory, "render-b.png"),
        renderDelta: join(temporaryDirectory, "render-delta.png"),
      }
      await extractFrame(options.reference, time, undefined, paths.referenceA)
      await extractFrame(options.reference, nextTime, undefined, paths.referenceB)
      await extractFrame(options.render, time, renderFilter, paths.renderA)
      await extractFrame(options.render, nextTime, renderFilter, paths.renderB)
      await difference(paths.referenceA, paths.referenceB, paths.referenceDelta)
      await difference(paths.renderA, paths.renderB, paths.renderDelta)
      results.push({
        absolute: await measurePsnr(paths.referenceB, paths.renderB),
        motion: await measurePsnr(paths.referenceDelta, paths.renderDelta),
        time,
      })
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }

  const motionScores = results.map((result) => result.motion)
  return {
    mean: motionScores.reduce((sum, value) => sum + value, 0) / motionScores.length,
    min: Math.min(...motionScores),
    results,
  }
}

function formatReport(report, interval, minimum) {
  const windows = report.results.map(
    ({ absolute, motion, time }) =>
      `window ${time.toFixed(2)}s→${(time + interval).toFixed(2)}s  ` +
      `motion-psnr=${motion.toFixed(2)}dB  (abs=${absolute.toFixed(1)}dB)${motion < minimum ? "  <-- BELOW THRESHOLD" : ""}`
  )
  const summary =
    `\nwindows=${report.results.length} min-motion=${report.min.toFixed(2)}dB ` +
    `mean-motion=${report.mean.toFixed(2)}dB threshold=${minimum}dB`
  const verdict =
    report.min < minimum
      ? "VERDICT: FAIL — choreography diverges from the Figma export (check timings, invented keyframes, durations)"
      : "VERDICT: PASS — motion matches the Figma export within the static-fidelity ceiling"
  return [...windows, summary, verdict].join("\n")
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (!options) return 0
  const report = await verifyMotion(options)
  process.stdout.write(`${formatReport(report, options.interval, options.minMotionPsnr)}\n`)
  return report.min < options.minMotionPsnr ? 1 : 0
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    const usage = error instanceof UsageError
    process.stderr.write(`${usage ? "Usage error" : "Preflight error"}: ${error.message}\n`)
    process.exitCode = usage ? EXIT_USAGE : EXIT_PREFLIGHT
  })
