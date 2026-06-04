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
 * CubismWebSamples `develop` branch (verified 2026-06-04).
 */
export const SAMPLE_MODEL_CATALOG: SampleModelEntry[] = [
  {
    id: "hiyori",
    name: "Hiyori",
    baseUrl: `${SAMPLE_BASE}Hiyori/`,
    settingsFile: "Hiyori.model3.json",
    files: [
      "Hiyori.model3.json",
      "Hiyori.moc3",
      "Hiyori.physics3.json",
      "Hiyori.pose3.json",
      "Hiyori.2048/texture_00.png",
      "Hiyori.2048/texture_01.png",
      "motions/Hiyori_m01.motion3.json",
      "motions/Hiyori_m02.motion3.json",
    ],
  },
  {
    id: "haru",
    name: "Haru",
    baseUrl: `${SAMPLE_BASE}Haru/`,
    settingsFile: "Haru.model3.json",
    files: [
      "Haru.model3.json",
      "Haru.moc3",
      "Haru.physics3.json",
      "Haru.pose3.json",
      "Haru.2048/texture_00.png",
      "Haru.2048/texture_01.png",
      "expressions/F01.exp3.json",
      "expressions/F02.exp3.json",
      "motions/haru_g_idle.motion3.json",
      "motions/haru_g_m01.motion3.json",
    ],
  },
]
