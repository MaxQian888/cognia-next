/**
 * Plugin SDK helper for `manifest.piPackages[]` entries (capability
 * `pi-package`, ADR-0210): a Pi coding-agent package shipped inside the plugin
 * directory, installable into the user's Pi and loadable into Cognia-hosted Pi
 * sessions.
 *
 * Pure: it returns the definition unchanged and throws on the author mistakes
 * the host would otherwise only report at install time — the same rules the
 * manifest validator enforces, surfaced while the author is still writing it.
 */

import {
  PI_PACKAGE_ENV_NAME_PATTERN,
  PI_PACKAGE_EXTENSION_SUFFIXES,
  PI_PACKAGE_ID_PATTERN,
  PI_PACKAGE_PREPARE_PROGRAMS,
  PI_PACKAGE_TOOL_NAME_PATTERN,
  type PluginPiPackageDef,
} from "@/types/plugin/plugin-pi-package"

/** Pi's built-in tools; a package cannot declare one as its own. */
const PI_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "edit", "write", "bash"])

function assertPluginRelative(path: unknown, context: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`${context} must be a non-empty plugin-relative path`)
  }
  if (path.includes("\\")) throw new Error(`${context} must use forward slashes`)
  if (/^(?:\/|[A-Za-z]:|[A-Za-z][A-Za-z0-9+.-]*:)/.test(path)) {
    throw new Error(`${context} must be relative to the plugin directory`)
  }
  if (path.split("/").includes("..")) {
    throw new Error(`${context} must not leave the plugin directory`)
  }
}

export function definePiPackage(def: PluginPiPackageDef): PluginPiPackageDef {
  const context = `definePiPackage: package "${def.id}"`
  if (!PI_PACKAGE_ID_PATTERN.test(def.id)) {
    throw new Error(`${context} id must be lowercase kebab-case`)
  }
  if (!def.name || def.name.trim().length === 0) {
    throw new Error(`${context} must declare a name`)
  }
  assertPluginRelative(def.path, `${context} path`)

  if (def.prepare) {
    if (!(PI_PACKAGE_PREPARE_PROGRAMS as readonly string[]).includes(def.prepare.program)) {
      throw new Error(
        `${context} prepare.program must be one of ${PI_PACKAGE_PREPARE_PROGRAMS.join(", ")}`
      )
    }
    if (
      !Array.isArray(def.prepare.args) ||
      def.prepare.args.some((arg) => typeof arg !== "string")
    ) {
      throw new Error(`${context} prepare.args must be static strings`)
    }
    if (def.prepare.marker !== undefined) {
      assertPluginRelative(def.prepare.marker, `${context} prepare.marker`)
    }
  }

  const hosted = def.hostedSession
  if (hosted) {
    if (!Array.isArray(hosted.extensions) || hosted.extensions.length === 0) {
      throw new Error(`${context} hostedSession.extensions must list at least one entry file`)
    }
    for (const entry of hosted.extensions) {
      assertPluginRelative(entry, `${context} hostedSession.extensions entry`)
      if (!PI_PACKAGE_EXTENSION_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
        throw new Error(
          `${context} extension "${entry}" must end in ${PI_PACKAGE_EXTENSION_SUFFIXES.join(", ")}`
        )
      }
    }
    for (const binding of hosted.env ?? []) {
      if (!PI_PACKAGE_ENV_NAME_PATTERN.test(binding.name)) {
        throw new Error(
          `${context} env name "${binding.name}" must be upper-case letters, digits and _`
        )
      }
    }
    for (const tool of hosted.tools ?? []) {
      if (!PI_PACKAGE_TOOL_NAME_PATTERN.test(tool) || PI_BUILTIN_TOOLS.has(tool)) {
        throw new Error(`${context} tool "${tool}" is not a valid, non-built-in tool name`)
      }
    }
  }
  return def
}
