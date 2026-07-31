// Single home for every Live2D URL, cap, and the downloadable sample catalog.
// No model files or Cubism Core are committed to the repo — the core is fetched
// to `public/live2d/` at build time and samples are fetched at runtime, both
// re-validated by `import-validate.ts` when they land.

/** Public CDN for the Cubism Core runtime (downloaded at build time). */
export const CUBISM_CORE_URL =
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"

/** Where the build script drops the core so the app can inject it offline. */
export const CUBISM_CORE_PUBLIC_PATH = "/live2d/live2dcubismcore.min.js"

/** Hard ceiling on a single model bundle's total bytes (50 MB). */
export const MAX_MODEL_BYTES = 50 * 1024 * 1024

/**
 * Minimum hold before the one-shot queue may advance while the Live2D skin is
 * active. The queue's natural durations come from the SVG specs (0.5–1.8s),
 * but a typical Cubism Tap/Special motion runs 1.5–3s — advancing on the SVG
 * clock force-cut motions mid-play. A conservative floor (not a per-motion
 * read: the engine surface doesn't expose durations pre-play) lets most
 * motions finish while keeping the queue responsive.
 */
export const LIVE2D_ONE_SHOT_HOLD_MS = 1600

/** A one-click downloadable sample model. */
export interface SampleModelEntry {
  /** Stable catalog id (also the persisted model id seed). */
  id: string
  /** Display name. */
  name: string
  /** Base URL every `files` entry is resolved against; ends with a slash. */
  baseUrl: string
  /** Settings file name (relative to `baseUrl`). */
  settingsFile: string
  /** Every file to fetch, relative to `baseUrl`. */
  files: string[]
}

const SAMPLE_BASE =
  "https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/"

/**
 * Official Cubism sample models. This is data only — the real file set is
 * verified at download time by `validateLive2dImport`, so a stale entry fails
 * loudly rather than silently rendering a broken model. Seeded from the
 * CubismWebSamples `develop` branch (verified 2026-06-23).
 *
 * `files` MUST list EVERY asset the model3.json references — not only the
 * mandatory moc/textures. Motions and expressions load lazily when a state
 * plays them, so a missing motion3.json/exp3.json (or a motion's referenced
 * `Sound`) is NOT caught by `validateLive2dImport` (it guards moc + textures
 * only). At play time the engine's `ModelSettings.replaceFiles` falls back to
 * the raw relative path when a reference has no downloaded blob, which then
 * 404s from the web root. Each list below is the complete FileReferences set
 * of its `*.model3.json`.
 */
export const SAMPLE_MODEL_CATALOG: SampleModelEntry[] = [
  {
    id: "hiyori",
    name: "Hiyori",
    baseUrl: `${SAMPLE_BASE}Hiyori/`,
    settingsFile: "Hiyori.model3.json",
    // Motions: Idle = m01,m02,m03,m05-m10; TapBody = m04. No expressions/sounds.
    files: [
      "Hiyori.model3.json",
      "Hiyori.moc3",
      "Hiyori.physics3.json",
      "Hiyori.pose3.json",
      "Hiyori.2048/texture_00.png",
      "Hiyori.2048/texture_01.png",
      "motions/Hiyori_m01.motion3.json",
      "motions/Hiyori_m02.motion3.json",
      "motions/Hiyori_m03.motion3.json",
      "motions/Hiyori_m04.motion3.json",
      "motions/Hiyori_m05.motion3.json",
      "motions/Hiyori_m06.motion3.json",
      "motions/Hiyori_m07.motion3.json",
      "motions/Hiyori_m08.motion3.json",
      "motions/Hiyori_m09.motion3.json",
      "motions/Hiyori_m10.motion3.json",
    ],
  },
  {
    id: "haru",
    name: "Haru",
    baseUrl: `${SAMPLE_BASE}Haru/`,
    settingsFile: "Haru.model3.json",
    // Motions: Idle = haru_g_idle,haru_g_m15; TapBody = m26,m06,m20,m09 (each
    // with a referenced Sound). Expressions: F01-F08.
    files: [
      "Haru.model3.json",
      "Haru.moc3",
      "Haru.physics3.json",
      "Haru.pose3.json",
      "Haru.2048/texture_00.png",
      "Haru.2048/texture_01.png",
      "expressions/F01.exp3.json",
      "expressions/F02.exp3.json",
      "expressions/F03.exp3.json",
      "expressions/F04.exp3.json",
      "expressions/F05.exp3.json",
      "expressions/F06.exp3.json",
      "expressions/F07.exp3.json",
      "expressions/F08.exp3.json",
      "motions/haru_g_idle.motion3.json",
      "motions/haru_g_m15.motion3.json",
      "motions/haru_g_m26.motion3.json",
      "motions/haru_g_m06.motion3.json",
      "motions/haru_g_m20.motion3.json",
      "motions/haru_g_m09.motion3.json",
      "sounds/haru_talk_13.wav",
      "sounds/haru_Info_14.wav",
      "sounds/haru_normal_6.wav",
      "sounds/haru_Info_04.wav",
    ],
  },
]
