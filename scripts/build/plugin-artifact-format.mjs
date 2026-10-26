// The plugin artifact set: everything the host build needs from first-party
// plugins, in one directory, so that building the app never reads plugin
// source.
//
// A producer (`scripts/plugin/artifacts/produce.mjs`, run wherever the plugin
// source lives) compiles the curated plugins into a set; the host consumes a
// set with `scripts/build/stage-plugin-artifacts.mjs`. The host owns this
// format — like the SDK contract catalog, a producer outside this repository
// follows it — and the consumer refuses any other schema.
//
// Layout of a set directory:
//
//   plugin-artifacts.json            { schema, files: { "<relative path>": "<sha256>" } }
//   builtin-plugins/**               browser built-in chunks, resources, shared pdf worker
//   plugin-icons/**                  package-owned identity images
//   desktop-plugins/**               installer-staged plugin directories
//   browser-builtin-assets.json      built-in registry index (chunk URLs + digests)
//   builtin-preboot-manifests.json   manifest fields read before the plugin manager boots
//   bundled-plugins.json             installer seed catalog (per-file digests)
//
// Every file in the set is listed in `plugin-artifacts.json` with its SHA-256,
// and the consumer verifies each one before staging it.

export const PLUGIN_ARTIFACT_SCHEMA = 1

/** The set's own manifest, at the root of the set directory. */
export const PLUGIN_ARTIFACT_MANIFEST = "plugin-artifacts.json"

/**
 * Chunk URLs are absolute paths under this prefix: the chunks are served from
 * `public/_cognia/builtin-plugins/` on every shell, and the index pins each URL.
 */
export const BUILTIN_CHUNK_URL_PREFIX = "/_cognia/builtin-plugins"

/**
 * Where each part of a set lands in the host tree, relative to the repository
 * root. `tree` sections are mirrored (files absent from the set are removed);
 * `file` sections are single generated files the app imports and commits.
 * `replaceWhole` trees are rewritten only when any byte differs, because a
 * watcher restarts the desktop app on every write there.
 */
export const PLUGIN_ARTIFACT_SECTIONS = Object.freeze({
  builtinChunks: Object.freeze({
    kind: "tree",
    set: "builtin-plugins",
    host: "public/_cognia/builtin-plugins",
  }),
  pluginIcons: Object.freeze({
    kind: "tree",
    set: "plugin-icons",
    host: "public/_cognia/plugin-icons",
  }),
  desktopPlugins: Object.freeze({
    kind: "tree",
    set: "desktop-plugins",
    host: "src-tauri/resources/plugins",
    replaceWhole: true,
  }),
  builtinIndex: Object.freeze({
    kind: "file",
    set: "browser-builtin-assets.json",
    host: "lib/plugin/core/browser-builtin-assets.generated.json",
  }),
  prebootManifests: Object.freeze({
    kind: "file",
    set: "builtin-preboot-manifests.json",
    host: "lib/plugin/core/builtin-preboot-manifests.generated.json",
  }),
  desktopCatalog: Object.freeze({
    kind: "file",
    set: "bundled-plugins.json",
    host: "lib/plugin/distribution/bundled-plugins.generated.json",
  }),
})

/** Host-owned curation the producer reads: which plugins ship, and how. */
export const PLUGIN_CURATION_FILES = Object.freeze({
  browserBuiltins: "lib/plugin/distribution/browser-builtins.json",
  distribution: "lib/plugin/distribution/distribution.json",
})

/** Reject anything but a plain relative path inside the set. */
export function assertSetRelativePath(relative) {
  if (
    typeof relative !== "string" ||
    !relative ||
    relative.startsWith("/") ||
    /[\\:\0]/.test(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe plugin artifact path: ${JSON.stringify(relative)}`)
  }
  return relative
}
