// Where the sidecar's own files live, whichever layout this module runs from.
//
// In the source tree (dev, the Tauri resources, the Docker image) this module
// sits at <sidecar>/src/platform/, two levels below the package root. A bundler
// (the CLI builds) flattens it into the bundle's own directory, and the
// packagers copy the files these paths name beside that bundle. Callers name a
// file relative to the sidecar root instead of counting `..` from their own
// depth, so moving a module never breaks the lookup.

import path from "node:path"
import { fileURLToPath } from "node:url"

/** The sidecar root for a module whose directory is `here`. */
export function resolveSidecarRoot(here: string): string {
  const sourceDir = path.join("src", "platform")
  return here.endsWith(path.sep + sourceDir) ? path.resolve(here, "..", "..") : here
}

export const SIDECAR_ROOT: string = resolveSidecarRoot(path.dirname(fileURLToPath(import.meta.url)))

/** An absolute path below the sidecar root. */
export function sidecarPath(...segments: string[]): string {
  return path.join(SIDECAR_ROOT, ...segments)
}
