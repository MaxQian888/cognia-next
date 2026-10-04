import { lstat, readdir, readFile, unlink } from "node:fs/promises"
import path from "node:path"
import { readFileSync } from "node:fs"

const { runtimeFormats } = JSON.parse(
  readFileSync(
    new URL("../../public/icons/cognia-mobile-spots/icon-manifest.json", import.meta.url),
    "utf8"
  )
)
const REPLACED_MOBILE_PNGS = new Map(
  runtimeFormats.webp.map((name) => [
    `icons/cognia-mobile-spots/png/${name}.png`,
    `icons/cognia-mobile-spots/webp/${name}.webp`,
  ])
)

// Export-only exclusions. Keep repository sources, manifests and generation inputs intact.
// Formats share MobileSpotIcon's manifest; getAgentTeamAvatarPath uses WebP.
// Never filter by extension globally or remove a PNG without its selected replacement.
export const MOBILE_ASSET_EXCLUSIONS = Object.freeze([
  "icons/cognia-mobile-spots/raw/",
  "icons/cognia-mobile-spots/qa/",
  ...REPLACED_MOBILE_PNGS.keys(),
  "icons/cognia-agent-team/raw/",
  "icons/cognia-agent-team/qa/",
  "icons/cognia-agent-team/png/",
  "icons/cognia-agent-team/contact-sheet-transparent.png",
  // Serwist is disabled on mobile, but Next still copies workers left by a web build.
  "sw.js",
  "sw.js.map",
  // Local generator freshness marker, ignored by Android asset packaging.
  "monaco/vs/.monaco-version",
])

// One scan per text file, even as the per-icon exclusion inventory grows.
const RUNTIME_REFERENCE = new RegExp(
  [
    ...MOBILE_ASSET_EXCLUSIONS.map((rule) =>
      (rule.startsWith("sw.") ? `/${rule}` : rule).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    ),
    "icons/cognia-mobile-spots/png/(?:[\"'`]|\\$\\{)",
  ].join("|")
)

export function isExcludedMobileAsset(relative) {
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid mobile asset path: ${relative}`)
  }
  return MOBILE_ASSET_EXCLUSIONS.some((rule) =>
    rule.endsWith("/") ? relative.startsWith(rule) : relative === rule
  )
}

async function collectFiles(directory, prefix = "") {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Mobile export is not a real directory: ${directory}`)
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name)
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Mobile export contains a symlink: ${relative}`)
    if (entry.isDirectory()) files.push(...(await collectFiles(file, relative)))
    else if (entry.isFile()) files.push(relative)
    else throw new Error(`Mobile export contains an unsupported entry: ${relative}`)
  }
  return files
}

/** Reject newly introduced runtime references before removing any export-owned file. */
export async function pruneMobileAssets(directory) {
  const files = await collectFiles(directory)
  if (!files.includes("index.html")) throw new Error("Mobile export is missing index.html")
  if (files.includes("cognia-mobile-artifact.json"))
    throw new Error("Cannot prune a stamped mobile export; rebuild it first")
  const removed = files.filter(isExcludedMobileAsset)
  const present = new Set(files)
  for (const relative of removed) {
    const replacement = REPLACED_MOBILE_PNGS.get(relative)
    if (replacement && !present.has(replacement))
      throw new Error(`Mobile export is missing replacement asset: ${replacement}`)
  }
  for (const relative of files) {
    if (isExcludedMobileAsset(relative) || !/\.(?:[cm]?js|html|css|txt|json)$/i.test(relative))
      continue
    const source = (await readFile(path.join(directory, relative), "utf8")).replaceAll("\\/", "/")
    const reference = source.match(RUNTIME_REFERENCE)?.[0]
    if (reference)
      throw new Error(
        `Mobile runtime asset reference in ${relative} prevents excluding ${reference}`
      )
  }
  let removedBytes = 0
  for (const relative of removed) {
    const file = path.join(directory, relative)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Mobile asset changed during pruning: ${relative}`)
    removedBytes += stat.size
    await unlink(file)
  }
  return { removedFiles: removed.length, removedBytes }
}
