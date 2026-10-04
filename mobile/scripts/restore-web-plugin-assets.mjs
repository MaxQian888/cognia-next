import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Capacitor clears public/plugins before generating Cordova shims. Next uses
// that same directory for /plugins route data and our browser plugin mirrors.
// Restore only export-owned files, without overwriting Cordova's own files.
export async function restoreWebPluginAssets(webDir, nativeWebDir) {
  const source = path.join(webDir, "plugins")
  try {
    await lstat(source)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw error
  }
  async function copyDirectory(from, to) {
    if (!(await lstat(from)).isDirectory())
      throw new Error(`Plugin asset directory must not be a symlink: ${from}`)
    await mkdir(to, { recursive: true })
    if (!(await lstat(to)).isDirectory())
      throw new Error(`Native plugin asset directory must not be a symlink: ${to}`)
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const input = path.join(from, entry.name)
      const output = path.join(to, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`Plugin assets must not contain symlinks: ${input}`)
      if (entry.isDirectory()) await copyDirectory(input, output)
      else if (entry.isFile()) {
        try {
          await copyFile(input, output, constants.COPYFILE_EXCL)
        } catch (error) {
          if (error.code !== "EEXIST") throw error
          if (
            !(await lstat(output)).isFile() ||
            !(await readFile(input)).equals(await readFile(output))
          ) {
            throw new Error(`Web plugin asset conflicts with a native plugin: ${output}`)
          }
        }
      }
    }
  }
  await copyDirectory(source, path.join(nativeWebDir, "plugins"))
}

export async function restoreFromCapacitorHook(env = process.env) {
  const platform = env.CAPACITOR_PLATFORM_NAME
  if (platform === "web") return
  if (!["android", "ios"].includes(platform) || !env.CAPACITOR_ROOT_DIR || !env.CAPACITOR_WEB_DIR) {
    throw new Error("Run this script through the capacitor:copy:after hook")
  }
  const config = JSON.parse(env.CAPACITOR_CONFIG || "{}")
  const nativeWebDir =
    platform === "android"
      ? path.resolve(
          env.CAPACITOR_ROOT_DIR,
          config.android?.path || "android",
          "app/src/main/assets/public"
        )
      : path.resolve(env.CAPACITOR_ROOT_DIR, config.ios?.path || "ios", "App/App/public")
  await restoreWebPluginAssets(env.CAPACITOR_WEB_DIR, nativeWebDir)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreFromCapacitorHook().catch((error) => {
    console.error(`[mobile-plugin-assets] ${error.message}`)
    process.exitCode = 1
  })
}
