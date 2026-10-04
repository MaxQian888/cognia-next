import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { isDeepStrictEqual } from "node:util"

const GENERATED = new Set([
  "capacitor.settings.gradle",
  "app/capacitor.build.gradle",
  "app/src/main/assets",
  "app/src/main/res/xml/config.xml",
  "capacitor-cordova-android-plugins",
])
const IGNORED = new Set([
  "build",
  ".gradle",
  ".idea",
  ".git",
  ".cxx",
  ".externalNativeBuild",
  "node_modules",
])
const digest = (value) => createHash("sha256").update(value).digest("hex")

// Hash bytes, names and missing inputs, never mtimes. Native inputs are separate
// from cap sync outputs so generation cannot hide a concurrent source edit.
async function addTree(hash, file, label, skip = () => false, ancestors = new Set()) {
  if (skip(label)) return
  let stat
  try {
    stat = await lstat(file)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    hash.update(`${label}\0missing\0`)
    return
  }
  if (stat.isSymbolicLink()) {
    const resolved = await realpath(file)
    if (ancestors.has(resolved)) throw new Error("Circular native input symlink")
    return addTree(hash, resolved, label, skip, new Set([...ancestors, resolved]))
  }
  if (stat.isDirectory()) {
    hash.update(`${label}\0directory\0`)
    for (const name of (await readdir(file)).sort()) {
      if (IGNORED.has(name) || name === ".cognia-build.lock") continue
      await addTree(hash, path.join(file, name), `${label}/${name}`, skip, ancestors)
    }
  } else if (stat.isFile()) {
    hash.update(`${label}\0${stat.size}\0`)
    hash.update(await readFile(file))
  } else throw new Error(`Unsupported native input: ${label}`)
}

export function devShellCache(root, env, toolchain, fileOperations = {}) {
  const write = fileOperations.writeFile ?? writeFile
  const move = fileOperations.rename ?? rename
  const native = path.join(root, "mobile/android")
  const sourceApk = path.join(native, "app/build/outputs/apk/debug/app-debug.apk")
  const directory = path.join(root, ".cache/mobile-dev-shell")
  const record = path.join(directory, "manifest.json")
  const sealedApk = (hash) => path.join(directory, `${hash}.apk`)
  const sha256 = /^[a-f0-9]{64}$/
  const readRecord = async () => {
    try {
      return JSON.parse(await readFile(record, "utf8"))
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code) || error instanceof SyntaxError)
        return null
      throw error
    }
  }
  // The workflow's native lock serializes publishers. Delete only archives and
  // staging files owned by this cache, retaining the currently published APK.
  const prune = async (keep) => {
    for (const name of await readdir(directory)) {
      if (
        (/^[a-f0-9]{64}\.apk$/.test(name) ||
          /^\.publish-[a-f0-9-]+\.(apk|json)\.tmp$/.test(name)) &&
        !keep.has(name)
      ) {
        await rm(path.join(directory, name), { force: true })
      }
    }
  }
  const generated = async () => {
    const hash = createHash("sha256")
    for (const name of [...GENERATED].sort()) await addTree(hash, path.join(native, name), name)
    return hash.digest("hex")
  }
  const fingerprint = async () => {
    const hash = createHash("sha256")
    hash.update("cognia-dev-shell-v1\0")
    const nativeEnv = Object.fromEntries(
      Object.entries(env)
        .filter(([key]) =>
          /^(JAVA_HOME|JAVA_OPTS|_JAVA_OPTIONS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|ANDROID_|GRADLE_|ORG_GRADLE_PROJECT_|COGNIA_MOBILE_DEV|COGNIA_PIN_)/.test(
            key
          )
        )
        .sort(([a], [b]) => a.localeCompare(b))
    )
    hash.update(JSON.stringify({ env: nativeEnv, javaVersion: toolchain.javaVersion }))
    await addTree(hash, native, "android", (name) =>
      [...GENERATED].some(
        (item) => name === `android/${item}` || name.startsWith(`android/${item}/`)
      )
    )
    for (const name of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "patches",
      "mobile/package.json",
      "mobile/capacitor.config.ts",
      "mobile/scripts",
      "mobile/.dev-web",
    ]) {
      await addTree(hash, path.join(root, name), name, (label) => /\.test\.[cm]?js$/.test(label))
    }
    // Read the installed native package bytes too: lockfiles alone do not detect
    // edits in linked workspace plugins or locally patched node_modules.
    const pkg = JSON.parse(await readFile(path.join(root, "mobile/package.json"), "utf8"))
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()) {
      const directory = path.join(root, "mobile/node_modules", name)
      await addTree(hash, directory, `dependency/${name}`)
    }
    const gradleHome = env.GRADLE_USER_HOME || path.join(os.homedir(), ".gradle")
    for (const name of ["gradle.properties", "init.gradle", "init.gradle.kts", "init.d"])
      await addTree(hash, path.join(gradleHome, name), `gradle-user/${name}`)
    await addTree(hash, path.join(env.JAVA_HOME || "", "release"), "jdk-release")
    // AGP's default debug signer lives outside the checkout. Hash bytes only;
    // replacing a key must not keep reusing an APK signed by the old identity.
    // ANDROID_SDK_HOME is the legacy *parent* of .android, unlike ANDROID_USER_HOME.
    const signingDirectories = new Set([
      path.join(os.homedir(), ".android"),
      ...(env.ANDROID_USER_HOME ? [env.ANDROID_USER_HOME] : []),
      ...(env.ANDROID_PREFS_ROOT ? [path.join(env.ANDROID_PREFS_ROOT, ".android")] : []),
      ...(env.ANDROID_SDK_HOME ? [path.join(env.ANDROID_SDK_HOME, ".android")] : []),
    ])
    for (const directory of [...signingDirectories].sort())
      await addTree(hash, path.join(directory, "debug.keystore"), `debug-signing/${directory}`)
    // Package metadata catches normal SDK upgrades without rereading every
    // installed platform/toolchain. Hash the active API stub bytes as well.
    const sdk = env.ANDROID_HOME
    if (sdk) {
      for (const category of ["build-tools", "platforms", "platform-tools", "ndk"]) {
        const directory = path.join(sdk, category)
        await addTree(
          hash,
          path.join(directory, "source.properties"),
          `sdk/${category}/source.properties`
        )
        for (const entry of (
          await readdir(directory, { withFileTypes: true }).catch((error) => {
            if (error.code === "ENOENT") return []
            throw error
          })
        )
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name))) {
          for (const name of ["source.properties", "package.xml"])
            await addTree(
              hash,
              path.join(directory, entry.name, name),
              `sdk/${category}/${entry.name}/${name}`
            )
        }
      }
      const variables = await readFile(path.join(native, "variables.gradle"), "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return ""
          throw error
        }
      )
      const api = variables.match(/\bcompileSdkVersion\s*=\s*(\d+)/)?.[1]
      if (api)
        for (const name of ["android.jar", "core-for-system-modules.jar"])
          await addTree(
            hash,
            path.join(sdk, "platforms", `android-${api}`, name),
            `sdk-active/${api}/${name}`
          )
    }
    return hash.digest("hex")
  }
  return {
    sourceApk,
    fingerprint,
    generated,
    async needsSigningKey() {
      let directory = env.ANDROID_USER_HOME
      if (!directory) {
        // Legacy overrides only apply when their parent directory already exists.
        for (const parent of [env.ANDROID_PREFS_ROOT, env.ANDROID_SDK_HOME].filter(Boolean)) {
          const exists = await lstat(parent).catch((error) => {
            if (error.code === "ENOENT") return null
            throw error
          })
          if (exists?.isDirectory() || exists?.isSymbolicLink()) {
            directory = path.join(parent, ".android")
            break
          }
        }
      }
      const key = path.join(directory || path.join(os.homedir(), ".android"), "debug.keystore")
      try {
        const value = await lstat(key)
        if (!value.isFile() && !value.isSymbolicLink())
          throw new Error("Android debug signing key is not a regular file")
        return false
      } catch (error) {
        if (error.code === "ENOENT") return true
        throw error
      }
    },
    async find(inputs) {
      const cached = await readRecord()
      if (
        !cached ||
        cached.version !== 2 ||
        cached.inputs !== inputs ||
        !sha256.test(cached.apkHash) ||
        !sha256.test(cached.generated)
      )
        return null
      const apk = sealedApk(cached.apkHash)
      try {
        if (!(await lstat(apk)).isFile() || cached.apkHash !== digest(await readFile(apk)))
          return null
        // Generated outputs were verified before this archive was published.
        // The shared Gradle tree may now contain a subsequent offline build.
        return { ...cached, apk }
      } catch (error) {
        if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null
        throw error
      }
    },
    async save(inputs, outputs) {
      if ((await fingerprint()) !== inputs || (await generated()) !== outputs)
        throw new Error(
          "Native inputs changed during the build; refusing to cache a mixed-source dev shell"
        )
      const bytes = await readFile(sourceApk)
      const { default: JSZip } = await import("jszip")
      const zip = await JSZip.loadAsync(bytes)
      const configEntry = zip.file("assets/capacitor.config.json")
      const pageEntry = zip.file("assets/public/index.html")
      if (!configEntry || !pageEntry)
        throw new Error("Dev APK is missing its configuration or shell")
      const config = JSON.parse(await configEntry.async("string"))
      const copiedConfig = JSON.parse(
        await readFile(path.join(native, "app/src/main/assets/capacitor.config.json"), "utf8")
      )
      if (
        !isDeepStrictEqual(config, copiedConfig) ||
        config.appId !== "com.cognia.mobile" ||
        config.server?.url !== env.COGNIA_MOBILE_DEV_URL ||
        config.server?.cleartext !== true ||
        config.android?.webContentsDebuggingEnabled !== true ||
        !(await pageEntry.async("string")).startsWith(
          "<!-- Generated by Cognia Android dev workflow. -->"
        )
      )
        throw new Error("Dev APK does not contain the expected live-reload shell")
      const cached = { version: 2, inputs, generated: outputs, apkHash: digest(bytes) }
      await mkdir(directory, { recursive: true })
      const previous = await readRecord()
      const previousName = sha256.test(previous?.apkHash) ? `${previous.apkHash}.apk` : undefined
      await prune(new Set(previousName ? [previousName] : []))
      const id = randomUUID()
      const temporaryApk = path.join(directory, `.publish-${id}.apk.tmp`)
      const temporaryRecord = path.join(directory, `.publish-${id}.json.tmp`)
      const apk = sealedApk(cached.apkHash)
      let published = false
      try {
        await write(temporaryApk, bytes, { flag: "wx" })
        await write(temporaryRecord, JSON.stringify(cached) + "\n", { flag: "wx" })
        if ((await fingerprint()) !== inputs || (await generated()) !== outputs)
          throw new Error(
            "Native inputs changed before cache publication; refusing a mixed-source dev shell"
          )
        await move(temporaryApk, apk)
        // Publish the pointer last. A crash beforehand leaves the previous
        // manifest valid; a crash afterwards leaves a fully written new APK.
        await move(temporaryRecord, record)
        published = true
      } finally {
        await rm(temporaryApk, { force: true })
        await rm(temporaryRecord, { force: true })
        if (!published && path.basename(apk) !== previousName) await rm(apk, { force: true })
      }
      await prune(new Set([path.basename(apk)]))
      return { ...cached, apk }
    },
  }
}

export async function installedDevShellMatches(adb, apkHash) {
  // Version codes and install receipts cannot distinguish an offline rebuild.
  // Require the bytes currently installed on this selected device to match.
  try {
    const paths = (await adb(["shell", "pm", "path", "com.cognia.mobile"], { capture: true }))
      .trim()
      .split(/\r?\n/)
    if (paths.length !== 1 || !/^package:\/data\/app\/[a-zA-Z0-9_+/.=~-]+\.apk$/.test(paths[0]))
      return false
    const installed = paths[0].slice(8)
    for (const command of [["sha256sum"], ["toybox", "sha256sum"]]) {
      try {
        const output = (await adb(["shell", ...command, installed], { capture: true })).trim()
        const match = output.match(/^([a-fA-F0-9]{64})\s+(.+)$/)
        if (match && match[2] === installed) return match[1].toLowerCase() === apkHash
      } catch {
        /* Older devices may only provide the toybox applet. */
      }
    }
  } catch {
    /* Missing packages and unreadable APKs must reinstall. */
  }
  return false
}
