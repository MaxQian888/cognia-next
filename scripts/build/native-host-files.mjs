// One description of the native helper binaries every CLI layout must carry.
//
// Three build scripts stage the same helpers into three different layouts
// (`build-cli.mjs` for the published npm package, `build-cli-binary.mjs` for the
// pkg layout, `build-cli-bun.mjs` for the Bun single-file targets), and each had
// its own hardcoded pair of names, source paths, existence checks and chmod
// calls. Adding a helper meant editing four places and the odds of missing one
// were exactly what they sound like: a layout that ships without a helper still
// starts, and then refuses at runtime with an error whose remedy is a build
// command the user cannot run.
//
// The set itself comes from `NATIVE_HOSTS`, which is also what decides what gets
// built, so "built" and "shipped" cannot disagree.

import path from "node:path"

import { NATIVE_HOSTS } from "./ensure-native-hosts.mjs"

/**
 * Env var pointing at a prebuilt binary for that helper. Release runners that
 * cross-compile set these because `target/release` on the build host holds the
 * wrong architecture.
 */
export const HOST_PATH_OVERRIDES = {
  "cognia-external-agent-launcher": "COGNIA_EXTERNAL_AGENT_LAUNCHER_PATH",
  "cognia-sandbox-exec": "COGNIA_SANDBOX_EXEC_PATH",
  "cognia-task-workspace-worker": "COGNIA_TASK_WORKSPACE_WORKER_PATH",
}

/** The command that produces the helper, quoted back at whoever is missing it. */
export const HOST_BUILD_HINTS = {
  "cognia-external-agent-launcher": "pnpm cli:external-host:build",
  "cognia-sandbox-exec": "pnpm cli:sandbox-exec:build",
  "cognia-task-workspace-worker": "pnpm cli:worker-workspace:build",
}

/**
 * Resolve every helper for one layout.
 *
 * `suffix` is the platform executable extension, which differs per build script
 * because the Bun path cross-compiles and cannot read `process.platform`.
 */
export function nativeHostFiles(root, options = {}) {
  const suffix = options.suffix ?? ""
  const env = options.env ?? process.env
  return NATIVE_HOSTS.map((host) => {
    const name = `${host.bin}${suffix}`
    const overrideEnv = HOST_PATH_OVERRIDES[host.bin]
    const override = overrideEnv ? env[overrideEnv] : undefined
    return {
      bin: host.bin,
      name,
      overrideEnv,
      overridden: Boolean(override),
      source: override || path.join(root, "target", "release", name),
      hint: HOST_BUILD_HINTS[host.bin] ?? "pnpm cli:native-hosts:build",
    }
  })
}

/** Just the filenames, for archive-mode and manifest checks. */
export function nativeHostFileNames(suffix = "") {
  return NATIVE_HOSTS.map((host) => `${host.bin}${suffix}`)
}

/**
 * The helpers whose source is missing, with the command that would produce it.
 * Returned rather than thrown so each build script keeps its own error prefix.
 */
export function missingNativeHosts(files, exists) {
  return files.filter((file) => !exists(file.source))
}
