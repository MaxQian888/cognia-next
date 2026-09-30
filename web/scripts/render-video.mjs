#!/usr/bin/env node
/**
 * Render the product films (ADR-0092, product footage amendment).
 *
 * Takes the HyperFrames project in `web/video/` — edited from real recordings
 * of the application (`record-product.mjs`) — renders each film for each
 * locale, and publishes the results the website reads:
 *
 *   web/public/video/<film>-<locale>.<hash>.mp4    H.264, faststart, under budget
 *   web/public/video/<film>-<locale>.<hash>.jpg    the poster
 *   web/public/video/<film>-<locale>.<hash>.vtt    captions (the product film)
 *   web/content/generated/product-videos.json      the manifest (`lib/product-videos.ts`)
 *
 * Two rules it enforces:
 *
 *  1. **A size budget per film.** The files are committed and served from
 *     Cloudflare Pages (25 MiB per file). Each encode walks a CRF ladder until
 *     it fits; a film that cannot fit at the ladder's floor fails the run
 *     rather than shipping soft or oversized.
 *  2. **One text for callouts and captions.** The caption track is generated
 *     from `web/video/film-copy.js`, the same file the composition draws its
 *     callouts from, timed by the same recorded beats.
 *
 * Filenames carry a content hash so `/video/*` can be cached immutably; the
 * previous files of a re-rendered film are deleted.
 *
 * Prerequisites (checked and reported, never installed):
 *   node web/scripts/record-product.mjs     # recordings/ + timing.js + hero shots
 *   ffmpeg on PATH; the HyperFrames CLI via `pnpm dlx hyperframes@<pinned>`
 *
 * Usage:
 *   node web/scripts/render-video.mjs
 *   node web/scripts/render-video.mjs --only product-film --locale zh
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { LOCALES } from "./demo-transcript.mjs"

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const VIDEO_PROJECT = join(WEB_ROOT, "video")
const PUBLIC_DIR = join(WEB_ROOT, "public", "video")
const MANIFEST = join(WEB_ROOT, "content", "generated", "product-videos.json")

/** The HyperFrames CLI the project is authored against (`web/video/package.json`). */
export const HYPERFRAMES = "hyperframes@0.8.93"

/**
 * The films, with their composition, budget and poster moment.
 *
 * The product film's poster is its opening title card (the promise, with the
 * app's mark); the hero loop's is its first frame, the task halted on
 * approval — which is also what reduced motion shows, so it must be the loop's
 * complete resting picture, not an arbitrary first frame.
 */
export const FILMS = {
  "hero-loop": {
    composition: "compositions/hero-loop.html",
    width: 1600,
    height: 1000,
    budgetBytes: 2_500_000,
    posterAtS: 0.05,
    audio: false,
    captions: false,
  },
  "product-film": {
    composition: "index.html",
    width: 1920,
    height: 1080,
    budgetBytes: 9_000_000,
    posterAtS: 2.4,
    audio: false,
    captions: true,
  },
}

/** CRF steps tried in order until an encode fits its budget. */
export const CRF_LADDER = [22, 24, 26, 28, 30]

/**
 * The film's structure the captions are timed against. Mirrors `index.html`
 * (`FOOTAGE_AT`, the last beat's end, the title-card windows); the test pins
 * the two together.
 */
export const FILM_LAYOUT = {
  footageAtS: 4,
  footageEndS: 37.6,
  openCue: [0.4, 3.5],
  closeCue: [38.6, 44],
}

export const BEAT_ORDER = [
  "request",
  "context",
  "reproduce",
  "plan",
  "fix",
  "verify",
  "notes",
  "approval",
]

export function parseArgs(argv) {
  const args = { locale: null, only: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--locale") args.locale = argv[++i]
    else if (argv[i] === "--only") args.only = argv[++i]
  }
  if (args.locale !== null && !LOCALES.includes(args.locale)) {
    throw new Error(`unsupported locale ${args.locale}; expected one of ${LOCALES.join(", ")}`)
  }
  if (args.only !== null && !(args.only in FILMS)) {
    throw new Error(`unknown film ${args.only}; expected one of ${Object.keys(FILMS).join(", ")}`)
  }
  return args
}

/** The composition variables a film renders under for a locale. */
export function filmVariables(id, locale) {
  if (id === "product-film") return { locale, recording: `recordings/${locale}.mp4` }
  if (id === "hero-loop") {
    const shot = (name) => `recordings/hero/${locale}/${name}.mp4`
    return {
      locale,
      seam: shot("seam"),
      reproduce: shot("reproduce"),
      fix: shot("fix"),
      halt: shot("halt"),
    }
  }
  throw new Error(`unknown film ${id}`)
}

/** `HH:MM:SS.mmm`, the WebVTT timestamp form. */
export function vttTime(seconds) {
  if (!(seconds >= 0)) throw new Error(`invalid cue time ${seconds}`)
  const ms = Math.round(seconds * 1000)
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const pad = (n, w = 2) => String(n).padStart(w, "0")
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`
}

/**
 * The product film's caption track for one locale: the opening card, one cue
 * per beat on its recorded start, the sign-off — the same words the film shows.
 *
 * @param {{ openTitle: string, closeTitle: string, beats: Record<string, [string, string]> }} copy
 * @param {{ beats: Record<string, { startS: number }> }} timing
 */
export function captionsVtt(copy, timing) {
  for (const beat of BEAT_ORDER) {
    if (!timing.beats[beat]) throw new Error(`captions: no ${beat} beat in the timing`)
    if (!copy.beats[beat]) throw new Error(`captions: no copy for the ${beat} beat`)
  }
  const cues = [{ from: FILM_LAYOUT.openCue[0], to: FILM_LAYOUT.openCue[1], text: copy.openTitle }]
  BEAT_ORDER.forEach((beat, i) => {
    const b = timing.beats[beat]
    const text = copy.beats[beat]
    const from = FILM_LAYOUT.footageAtS + b.startS + 0.2
    const next = BEAT_ORDER[i + 1]
    const to = next ? FILM_LAYOUT.footageAtS + timing.beats[next].startS : FILM_LAYOUT.footageEndS
    if (to <= from) throw new Error(`captions: the ${beat} cue has no duration`)
    cues.push({ from, to, text: `${text[0]} — ${text[1]}` })
  })
  cues.push({ from: FILM_LAYOUT.closeCue[0], to: FILM_LAYOUT.closeCue[1], text: copy.closeTitle })
  const body = cues.map(
    (cue, i) => `${i + 1}\n${vttTime(cue.from)} --> ${vttTime(cue.to)}\n${cue.text}\n`
  )
  return `WEBVTT\n\n${body.join("\n")}`
}

/** The first ten hex digits of a file's SHA-256: enough to make the name change. */
export function contentHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 10)
}

/** ffmpeg arguments for the published encode at one CRF step. */
export function encodeArgs(input, output, { crf, audio }) {
  return [
    "-y",
    "-loglevel",
    "error",
    "-i",
    input,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-profile:v",
    "high",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    ...(audio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-movflags",
    "+faststart",
    output,
  ]
}

/**
 * ffmpeg arguments for the poster at `atS`: a JPEG, because every browser
 * decodes it and the ffmpeg this runs against is not guaranteed a WebP encoder.
 */
export function posterArgs(input, output, atS) {
  return [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    atS.toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-c:v",
    "mjpeg",
    "-q:v",
    "3",
    output,
  ]
}

/**
 * The published files of one film and locale that a new render supersedes:
 * everything named `<film>-<locale>.<hash>.<ext>` except the kept hash.
 */
export function staleOutputs(files, id, locale, keepHash) {
  const pattern = new RegExp(`^${id}-${locale}\\.([0-9a-f]{10})\\.(mp4|jpg|vtt)$`)
  return files.filter((file) => {
    const match = pattern.exec(file)
    return match !== null && match[1] !== keepHash
  })
}

/** Replace the rendered entries; keep films this run did not touch. */
export function mergeVideoManifest(existing, rendered, renderedAt) {
  return { renderedAt, videos: { ...existing.videos, ...rendered } }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.slice(0, 3).join(" ")} failed:\n${result.stderr || result.stdout}`
    )
  }
  return result
}

function readFilmCopy() {
  const window = {}
  new Function("window", readFileSync(join(VIDEO_PROJECT, "film-copy.js"), "utf8"))(window)
  return window.__cogniaFilmCopy
}

function readTiming() {
  const window = {}
  const file = join(VIDEO_PROJECT, "recordings", "timing.js")
  if (!existsSync(file)) throw new Error("recordings/timing.js is missing; run record-product.mjs")
  new Function("window", readFileSync(file, "utf8"))(window)
  return window.__cogniaFootageTiming
}

/**
 * HyperFrames drives its own headless Chrome. When none is configured, use the
 * Playwright Chromium this repository already installs.
 */
async function browserEnv() {
  if (process.env.HYPERFRAMES_BROWSER_PATH) return process.env
  const { loadChromium } = await import("./capture-og.mjs")
  const chromium = await loadChromium()
  if (!chromium) return process.env
  return { ...process.env, HYPERFRAMES_BROWSER_PATH: chromium.executablePath() }
}

function renderFilm(id, locale, env) {
  const film = FILMS[id]
  const rendersDir = join(VIDEO_PROJECT, "renders")
  mkdirSync(rendersDir, { recursive: true })
  const raw = join(rendersDir, `${id}-${locale}.mp4`)
  run(
    "pnpm",
    [
      "dlx",
      HYPERFRAMES,
      "render",
      ...(film.composition === "index.html" ? [] : ["-c", film.composition]),
      "--quality",
      "high",
      "--video-frame-format",
      "png",
      "--strict",
      "--variables",
      JSON.stringify(filmVariables(id, locale)),
      "-o",
      raw,
    ],
    { cwd: VIDEO_PROJECT, env }
  )
  return raw
}

function publish(id, locale, raw, { copy, timing }) {
  const film = FILMS[id]
  mkdirSync(PUBLIC_DIR, { recursive: true })
  const staging = join(VIDEO_PROJECT, "renders", `${id}-${locale}.encoded.mp4`)
  let bytes = Number.POSITIVE_INFINITY
  let crf = null
  for (const step of CRF_LADDER) {
    run("ffmpeg", encodeArgs(raw, staging, { crf: step, audio: film.audio }))
    bytes = statSync(staging).size
    crf = step
    if (bytes <= film.budgetBytes) break
  }
  if (bytes > film.budgetBytes) {
    throw new Error(
      `${id}-${locale} is ${bytes} bytes at CRF ${crf}, over its ${film.budgetBytes}-byte budget`
    )
  }

  const encoded = readFileSync(staging)
  const hash = contentHash(encoded)
  const base = `${id}-${locale}.${hash}`
  writeFileSync(join(PUBLIC_DIR, `${base}.mp4`), encoded)
  run("ffmpeg", posterArgs(staging, join(PUBLIC_DIR, `${base}.jpg`), film.posterAtS))
  if (film.captions) {
    writeFileSync(join(PUBLIC_DIR, `${base}.vtt`), captionsVtt(copy[locale], timing[locale]))
  }
  for (const stale of staleOutputs(readdirSync(PUBLIC_DIR), id, locale, hash)) {
    rmSync(join(PUBLIC_DIR, stale))
  }

  const probe = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    staging,
  ])
  console.log(`[render] ${base}.mp4 — ${(bytes / 1e6).toFixed(2)} MB at CRF ${crf}`)
  return {
    src: `/video/${base}.mp4`,
    poster: `/video/${base}.jpg`,
    width: film.width,
    height: film.height,
    bytes,
    durationS: Number(Number(probe.stdout.trim()).toFixed(2)),
    ...(film.captions ? { captions: `/video/${base}.vtt` } : {}),
    hasAudio: film.audio,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  run("ffmpeg", ["-version"])
  const copy = readFilmCopy()
  const timing = readTiming()
  const env = await browserEnv()

  const locales = args.locale ? [args.locale] : LOCALES
  const films = args.only ? [args.only] : Object.keys(FILMS)
  const rendered = {}
  for (const locale of locales) {
    if (!timing[locale]) throw new Error(`recordings/timing.js has no ${locale} timing`)
    for (const id of films) {
      const raw = renderFilm(id, locale, env)
      rendered[`${id}-${locale}`] = publish(id, locale, raw, { copy, timing })
    }
  }

  const existing = existsSync(MANIFEST)
    ? JSON.parse(readFileSync(MANIFEST, "utf8"))
    : { renderedAt: null, videos: {} }
  const manifest = mergeVideoManifest(existing, rendered, new Date().toISOString())
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`[render] manifest now lists ${Object.keys(manifest.videos).length} film(s)`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
