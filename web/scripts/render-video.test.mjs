import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  BEAT_ORDER,
  CRF_LADDER,
  FILMS,
  FILM_LAYOUT,
  VIDEO_PROJECT,
  captionsVtt,
  contentHash,
  encodeArgs,
  filmVariables,
  mergeVideoManifest,
  parseArgs,
  posterArgs,
  staleOutputs,
  vttTime,
} from "./render-video.mjs"
import { BEATS } from "./demo-transcript.mjs"

const COPY = {
  openTitle: "One task, end to end.",
  closeTitle: "Your open workspace for AI agents.",
  beats: Object.fromEntries(BEATS.map((b, i) => [b, [`0${i + 1} · ${b}`, `Line ${b}.`]])),
}
const TIMING = {
  beats: Object.fromEntries(BEATS.map((b, i) => [b, { startS: 1 + i * 3 }])),
}

test("parseArgs accepts a locale and a film, and refuses unknown ones", () => {
  assert.deepEqual(parseArgs([]), { locale: null, only: null })
  assert.deepEqual(parseArgs(["--locale", "zh", "--only", "hero-loop"]), {
    locale: "zh",
    only: "hero-loop",
  })
  assert.throws(() => parseArgs(["--locale", "fr"]), /unsupported locale fr/)
  assert.throws(() => parseArgs(["--only", "trailer"]), /unknown film trailer/)
})

test("the caption beats are the transcript's beats, in its order", () => {
  assert.deepEqual(BEAT_ORDER, BEATS)
})

test("filmVariables points each film at its own locale's footage", () => {
  assert.deepEqual(filmVariables("product-film", "zh"), {
    locale: "zh",
    recording: "recordings/zh.mp4",
  })
  assert.deepEqual(filmVariables("hero-loop", "en"), {
    locale: "en",
    seam: "recordings/hero/en/seam.mp4",
    reproduce: "recordings/hero/en/reproduce.mp4",
    fix: "recordings/hero/en/fix.mp4",
    halt: "recordings/hero/en/halt.mp4",
  })
  assert.throws(() => filmVariables("trailer", "en"), /unknown film/)
})

test("the variables match what each composition declares", () => {
  for (const [id, film] of Object.entries(FILMS)) {
    const html = readFileSync(join(VIDEO_PROJECT, film.composition), "utf8")
    for (const key of Object.keys(filmVariables(id, "en"))) {
      assert.match(html, new RegExp(`"id":"${key}"`), `${film.composition} declares ${key}`)
    }
  }
})

test("the caption layout mirrors the film composition's timing", () => {
  const html = readFileSync(join(VIDEO_PROJECT, "index.html"), "utf8")
  assert.match(html, new RegExp(`const FOOTAGE_AT = ${FILM_LAYOUT.footageAtS}\\b`))
  assert.match(html, new RegExp(`: ${FILM_LAYOUT.footageEndS}\\b`))
  assert.match(html, new RegExp(`data-duration="${FILM_LAYOUT.closeCue[1]}"`))
})

test("vttTime formats hours, minutes, seconds and milliseconds", () => {
  assert.equal(vttTime(0), "00:00:00.000")
  assert.equal(vttTime(37.6), "00:00:37.600")
  assert.equal(vttTime(3723.0456), "01:02:03.046")
  assert.throws(() => vttTime(-1), /invalid cue time/)
})

test("captionsVtt carries the open card, one cue per beat on its recorded time, and the close", () => {
  const vtt = captionsVtt(COPY, TIMING)
  assert.ok(vtt.startsWith("WEBVTT\n\n"))
  const cues = vtt.trim().split("\n\n").slice(1)
  assert.equal(cues.length, BEATS.length + 2)
  assert.match(cues[0], /00:00:00\.400 --> 00:00:03\.500\nOne task, end to end\./)
  // request starts at 1s of footage, which begins at 4s; the cue follows by 0.2s.
  assert.match(cues[1], /00:00:05\.200 --> 00:00:08\.000\n01 · request — Line request\./)
  assert.match(cues[8], /--> 00:00:37\.600\n08 · approval — Line approval\./)
  assert.match(cues[9], /00:00:38\.600 --> 00:00:44\.000\nYour open workspace/)
})

test("captionsVtt refuses a timing or copy with a missing beat", () => {
  const { fix: _fix, ...beats } = TIMING.beats
  assert.throws(() => captionsVtt(COPY, { beats }), /no fix beat/)
  const { plan: _plan, ...copyBeats } = COPY.beats
  assert.throws(
    () => captionsVtt({ ...COPY, beats: copyBeats }, TIMING),
    /no copy for the plan beat/
  )
})

test("the real film copy covers every beat in both locales", () => {
  const window = {}
  new Function("window", readFileSync(join(VIDEO_PROJECT, "film-copy.js"), "utf8"))(window)
  for (const locale of ["en", "zh"]) {
    const copy = window.__cogniaFilmCopy[locale]
    assert.deepEqual(Object.keys(copy.beats), BEATS)
    assert.ok(captionsVtt(copy, TIMING).includes(copy.closeTitle))
  }
})

test("contentHash is ten hex digits and changes with the content", () => {
  const a = contentHash(Buffer.from("a"))
  assert.match(a, /^[0-9a-f]{10}$/)
  assert.notEqual(a, contentHash(Buffer.from("b")))
})

test("encodeArgs keeps audio only for films that have it, always faststart", () => {
  const silent = encodeArgs("/in.mp4", "/out.mp4", { crf: 24, audio: false })
  assert.ok(silent.includes("-an"))
  assert.equal(silent[silent.indexOf("-crf") + 1], "24")
  assert.equal(silent[silent.indexOf("-movflags") + 1], "+faststart")
  const withAudio = encodeArgs("/in.mp4", "/out.mp4", { crf: 22, audio: true })
  assert.equal(withAudio[withAudio.indexOf("-c:a") + 1], "aac")
  assert.ok(!withAudio.includes("-an"))
})

test("both films are silent — the captions carry the words", () => {
  for (const [id, film] of Object.entries(FILMS)) assert.equal(film.audio, false, id)
  assert.equal(FILMS["product-film"].captions, true)
})

test("posterArgs grabs one JPEG frame at the poster moment", () => {
  const args = posterArgs("/in.mp4", "/p.jpg", 2.4)
  assert.equal(args[args.indexOf("-ss") + 1], "2.400")
  assert.equal(args[args.indexOf("-frames:v") + 1], "1")
  assert.equal(args[args.indexOf("-c:v") + 1], "mjpeg")
})

test("the budgets fit Cloudflare Pages and the ladder only gets smaller", () => {
  for (const film of Object.values(FILMS)) assert.ok(film.budgetBytes < 25 * 1024 * 1024)
  assert.deepEqual(
    CRF_LADDER,
    [...CRF_LADDER].sort((a, b) => a - b)
  )
})

test("staleOutputs lists only the same film and locale under another hash", () => {
  const files = [
    "hero-loop-en.aaaaaaaaaa.mp4",
    "hero-loop-en.aaaaaaaaaa.jpg",
    "hero-loop-en.bbbbbbbbbb.mp4",
    "hero-loop-zh.aaaaaaaaaa.mp4",
    "product-film-en.aaaaaaaaaa.vtt",
    "notes.txt",
  ]
  assert.deepEqual(staleOutputs(files, "hero-loop", "en", "bbbbbbbbbb"), [
    "hero-loop-en.aaaaaaaaaa.mp4",
    "hero-loop-en.aaaaaaaaaa.jpg",
  ])
})

test("mergeVideoManifest replaces rendered films and keeps the rest", () => {
  const merged = mergeVideoManifest(
    { renderedAt: "old", videos: { "hero-loop-en": { src: "a" }, "hero-loop-zh": { src: "b" } } },
    { "hero-loop-en": { src: "c" } },
    "new"
  )
  assert.deepEqual(merged, {
    renderedAt: "new",
    videos: { "hero-loop-en": { src: "c" }, "hero-loop-zh": { src: "b" } },
  })
})

test("the published films are served immutable, because every name carries its hash", () => {
  const headers = readFileSync(join(VIDEO_PROJECT, "..", "public", "_headers"), "utf8")
  const rules = headers.split("\n").filter((line) => !line.startsWith("#"))
  const at = rules.indexOf("/video/*")
  assert.notEqual(at, -1, "_headers has a /video/* rule")
  assert.match(rules[at + 1], /Cache-Control: public, max-age=31536000, immutable/)
  // Stable-named screenshots must not be pinned.
  assert.ok(!rules.some((line) => line.startsWith("/product/")))
  // And the manifest only ever points at hashed names.
  const manifest = JSON.parse(
    readFileSync(join(VIDEO_PROJECT, "..", "content", "generated", "product-videos.json"), "utf8")
  )
  for (const video of Object.values(manifest.videos)) {
    for (const path of [video.src, video.poster, video.captions].filter(Boolean)) {
      assert.match(path, /^\/video\/[a-z-]+-(en|zh)\.[0-9a-f]{10}\.(mp4|jpg|vtt)$/)
    }
  }
})
