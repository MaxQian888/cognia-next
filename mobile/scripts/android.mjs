#!/usr/bin/env node
import { spawn } from "node:child_process"
import { access, mkdir, open, readFile, rm } from "node:fs/promises"
import { constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import {
  sourceFingerprint,
  stampArtifact,
  verifyArtifact,
  verifyOfflineConfig,
} from "./android-artifact.mjs"

import { pruneMobileAssets } from "./mobile-assets.mjs"
import { devShellCache, installedDevShellMatches } from "./android-dev-shell.mjs"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const HELP = `Android workflows:
  dev     Live reload in a native shell; --port=3002 --bundler=webpack|turbopack
          --timeout-seconds=600 controls cold compilation readiness
  native  Reuse verified mobile assets; --refresh=none|copy|sync (default sync)
  build   Build an offline APK without installing it; --release optional
  deploy  Build an offline debug APK, install, and launch
  sync    Build mobile web assets and sync Android only (no JDK/device needed)
Options: --serial=DEVICE --no-install (native only) --help
Native refresh: none = Java/resources only; copy = Capacitor config; sync = plugins.
Release APKs remain unsigned. Dev server, reverse mapping, and child processes are session-owned.`

export function parseArgs(args) {
  const [mode = "help", ...flags] = args
  const result = {
    mode,
    port: 3002,
    timeoutMs: 600_000,
    bundler: "webpack",
    refresh: "sync",
    install: true,
    release: false,
    serial: undefined,
    help: mode === "help" || mode === "--help",
  }
  if (!result.help && !["dev", "native", "build", "deploy", "sync"].includes(mode))
    throw new Error(`Unknown Android mode: ${mode}`)
  for (const flag of flags) {
    if (flag === "--help") result.help = true
    else if (flag === "--release" && mode === "build") result.release = true
    else if (flag === "--no-install" && mode === "native") result.install = false
    else if (flag.startsWith("--serial=")) {
      result.serial = flag.slice(9)
      if (!/^[a-zA-Z0-9_.:-]+$/.test(result.serial)) throw new Error("Invalid adb serial")
    } else if (flag.startsWith("--port=") && mode === "dev") {
      const port = flag.slice(7)
      if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
        throw new Error("Dev port must be an integer from 1024 to 65535")
      result.port = Number(port)
    } else if (flag.startsWith("--timeout-seconds=") && mode === "dev") {
      const seconds = flag.slice(18)
      if (!/^\d+$/.test(seconds) || Number(seconds) < 10 || Number(seconds) > 3600)
        throw new Error("Readiness timeout must be 10 to 3600 seconds")
      result.timeoutMs = Number(seconds) * 1000
    } else if (
      flag.startsWith("--bundler=") &&
      mode === "dev" &&
      ["webpack", "turbopack"].includes(flag.slice(10))
    )
      result.bundler = flag.slice(10)
    else if (
      flag.startsWith("--refresh=") &&
      mode === "native" &&
      ["none", "copy", "sync"].includes(flag.slice(10))
    )
      result.refresh = flag.slice(10)
    else throw new Error(`Unsupported option for ${mode}: ${flag}`)
  }
  return result
}

export function selectDevice(output, serial) {
  const devices = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => ["device", "offline", "unauthorized"].includes(parts[1]))
  if (serial) {
    const device = devices.find(([id]) => id === serial)
    if (!device || device[1] !== "device")
      throw new Error(`Device ${serial} is not authorized and online`)
    return serial
  }
  const ready = devices.filter(([, state]) => state === "device")
  if (ready.length === 0)
    throw new Error("No authorized Android device; connect one and allow USB debugging")
  if (ready.length > 1) throw new Error("There are multiple Android devices; pass --serial=DEVICE")
  return ready[0][0]
}

export function parseReverse(output) {
  return new Map(
    output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).slice(-2))
  )
}

function spawnCommand(command, args, options = {}) {
  const env = options.env ?? process.env
  if (command === "pnpm" && env.npm_execpath?.match(/pnpm[^/\\]*\.(?:c?js)$/)) {
    args = [env.npm_execpath, ...args]
    command = process.execPath
  } else if (process.platform === "win32" && command === "pnpm") command = "pnpm.cmd"
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
  if (shell && args.some((arg) => /[&|<>^%!\r\n"]/.test(arg)))
    throw new Error("Unsafe Windows shell argument")
  return spawn(command, args, {
    cwd: options.cwd,
    env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell,
    detached: process.platform !== "win32",
  })
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  try {
    if (process.platform === "win32") child.kill("SIGTERM")
    else process.kill(-child.pid, "SIGTERM")
  } catch (error) {
    if (error.code !== "ESRCH") throw error
  }
}

async function terminateChild(child) {
  if (
    process.platform === "win32" &&
    child.pid &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    await commandRunner("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      capture: true,
    }).catch(() => stopChild(child))
    return
  }
  stopChild(child)
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++)
    await delay(100)
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === "win32")
    await commandRunner("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      capture: true,
    }).catch(() => {})
  else
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
}

export function commandRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason)
      return
    }
    const child = spawnCommand(command, args, options)
    let stdout = "",
      stderr = ""
    child.stdout?.on("data", (value) => {
      stdout += value
    })
    child.stderr?.on("data", (value) => {
      stderr += value
    })
    const abort = () => {
      void terminateChild(child).catch(reject)
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      options.signal?.removeEventListener("abort", abort)
      if (code === 0) resolve(stdout)
      else
        reject(
          new Error(
            `${path.basename(command)} ${args.join(" ")} failed (${signal ?? code})${stderr ? `\n${stderr}` : ""}`
          )
        )
    })
  })
}

async function executable(file) {
  try {
    await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveToolchain(
  root,
  env,
  run,
  {
    needAdb = true,
    platform = process.platform,
    home = os.homedir(),
    canExecute = executable,
    read = readFile,
  } = {}
) {
  const windows = platform === "win32"
  const suffix = windows ? ".exe" : ""
  const sdkCandidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    path.join(home, "Library/Android/sdk"),
    path.join(home, "Android/Sdk"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Android/Sdk"),
    "/opt/homebrew/share/android-commandlinetools",
  ].filter(Boolean)
  const localProperties = await read(
    path.join(root, "mobile/android/local.properties"),
    "utf8"
  ).catch(() => "")
  const configuredSdk = localProperties
    .match(/^sdk\.dir=(.+)$/m)?.[1]
    ?.trim()
    .replace(/\\:/g, ":")
    .replace(/\\\\/g, "\\")
  if (configuredSdk) sdkCandidates.unshift(configuredSdk)
  let sdk, adb
  for (const candidate of sdkCandidates) {
    if (await canExecute(path.join(candidate, "platform-tools", `adb${suffix}`))) {
      sdk = candidate
      adb = path.join(candidate, "platform-tools", `adb${suffix}`)
      break
    }
  }
  if (!sdk) throw new Error("Android SDK not found; set ANDROID_HOME (including platform-tools)")
  const jdkCandidates = [
    env.JAVA_HOME_21,
    env.JAVA_HOME,
    "/opt/homebrew/opt/openjdk@21",
    "/usr/local/opt/openjdk@21",
    "/usr/lib/jvm/java-21-openjdk-amd64",
    "/usr/lib/jvm/java-21-openjdk-arm64",
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
    env.ProgramFiles && path.join(env.ProgramFiles, "Android/Android Studio/jbr"),
  ].filter(Boolean)
  if (platform === "darwin") {
    try {
      jdkCandidates.push(
        (await run("/usr/libexec/java_home", ["-v", "21"], { capture: true })).trim()
      )
    } catch {
      /* Explicit candidates still apply. */
    }
  }
  let javaHome, javaVersion
  for (const candidate of jdkCandidates) {
    if (!(await canExecute(path.join(candidate, "bin", `javac${suffix}`)))) continue
    try {
      const version = await run(path.join(candidate, "bin", `javac${suffix}`), ["-version"], {
        capture: true,
      })
      if (/javac 21(?:\.|\s|$)/.test(version)) {
        javaHome = candidate
        javaVersion = version.trim()
        break
      }
    } catch {
      /* Try the next installed JDK. */
    }
  }
  if (!javaHome)
    throw new Error("JDK 21 not found; set JAVA_HOME_21 or JAVA_HOME to a JDK 21 installation")
  const gradle = path.join(root, "mobile/android", windows ? "gradlew.bat" : "gradlew")
  if (windows && !(await canExecute(gradle))) throw new Error(`Gradle wrapper not found: ${gradle}`)
  return {
    javaVersion,
    adb: needAdb ? adb : undefined,
    gradle: windows ? gradle : "sh",
    gradleArgs: windows ? [] : [gradle],
    env: { ...env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
  }
}

async function ensurePortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", () =>
      reject(
        new Error(`Port ${port} is occupied; use another --port, or stop its owner explicitly`)
      )
    )
    server.listen(port, "127.0.0.1", () => server.close(resolve))
  })
}

export async function startDevServer(root, env, options, signal, log = console.log) {
  await ensurePortAvailable(options.port)
  const child = spawnCommand(
    "pnpm",
    [
      "exec",
      "next",
      "dev",
      `--${options.bundler}`,
      "--hostname",
      "127.0.0.1",
      "--port",
      String(options.port),
    ],
    { cwd: root, env }
  )
  let failure
  child.once("error", (error) => {
    failure = error
  })
  child.once("exit", (code, reason) => {
    failure ??= new Error(`Mobile dev server stopped (${reason ?? code})`)
  })
  let stopping
  const stop = () => {
    signal?.removeEventListener("abort", stop)
    // Abort and the workflow's finally can arrive together. Share cleanup so
    // an exiting process group is never signalled twice.
    stopping ??= terminateChild(child)
    return stopping
  }
  signal?.addEventListener("abort", stop, { once: true })
  try {
    const deadline = Date.now() + options.timeoutMs
    let lastStatus = "connection unavailable"
    let nextProgress = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason
      if (failure) throw failure
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/`, {
          signal: AbortSignal.any([AbortSignal.timeout(2500), ...(signal ? [signal] : [])]),
        })
        lastStatus = `HTTP ${response.status}`
        await response.body?.cancel()
        if (response.ok)
          return {
            stop,
            wait: async () => {
              while (!signal?.aborted) {
                if (failure) throw failure
                await delay(200)
              }
            },
          }
      } catch {
        /* Startup and initial compilation may not be ready yet. */
      }
      if (Date.now() >= nextProgress) {
        log(
          `[mobile] Waiting for first mobile page compilation (${lastStatus}); ${Math.ceil((deadline - Date.now()) / 1000)}s remaining`
        )
        nextProgress = Date.now() + 15_000
      }
      await delay(200)
    }
    throw new Error(
      `Mobile dev server did not become ready within ${options.timeoutMs / 1000} seconds (${lastStatus})`
    )
  } catch (error) {
    await stop()
    throw error
  }
}

export async function prepareDevWeb(root) {
  const directory = path.join(root, "mobile/.dev-web")
  const marker = "<!-- Generated by Cognia Android dev workflow. -->"
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, "index.html")
  try {
    const handle = await open(file, "wx")
    try {
      await handle.writeFile(
        `${marker}\n<!doctype html><html lang="en"><meta charset="utf-8"><title>Cognia development</title><body>Start mobile:dev:android to connect this development shell.</body></html>\n`
      )
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    if (!(await readFile(file, "utf8")).startsWith(marker))
      throw new Error(`Refusing to replace an unowned dev page: ${file}`)
  }
}

export async function runAndroid(options, overrides = {}) {
  if (options.help) {
    ;(overrides.log ?? console.log)(HELP)
    return
  }
  const root = overrides.root ?? ROOT
  const inherited = overrides.env ?? process.env
  const signal = overrides.signal
  const log = overrides.log ?? console.log
  const rawRun = overrides.run ?? commandRunner
  const env = {
    ...inherited,
    NEXT_PUBLIC_PLATFORM: "mobile",
    NODE_OPTIONS: inherited.NODE_OPTIONS || "--max-old-space-size=16384",
    COGNIA_MOBILE_DEV: options.mode === "dev" ? "1" : "0",
    COGNIA_NEXT_DIST_DIR: options.mode === "dev" ? ".next-mobile-dev" : ".next",
  }
  delete env.TAURI_DEV_HOST
  delete env.COGNIA_MOBILE_DEV_URL
  if (options.mode === "dev") env.COGNIA_MOBILE_DEV_URL = `http://localhost:${options.port}`
  const run = (command, args, extra = {}) =>
    rawRun(command, args, { cwd: root, env, signal, ...extra })
  const fingerprint = overrides.fingerprint ?? (() => sourceFingerprint(root, run, env))
  const stamp = overrides.stamp ?? stampArtifact
  const verify = overrides.verify ?? verifyArtifact
  const verifyConfig = overrides.verifyConfig ?? verifyOfflineConfig
  const nativeDir = path.join(root, "mobile/android")
  const copied = path.join(nativeDir, "app/src/main/assets/public")
  const configFile = path.join(nativeDir, "app/src/main/assets/capacitor.config.json")
  const output = path.join(root, "out")
  const cap = (operation) =>
    run("pnpm", ["--filter", "mobile", "exec", "cap", operation, "android"])
  const needsDevice =
    options.mode === "dev" ||
    options.mode === "deploy" ||
    (options.mode === "native" && options.install)
  const toolchain =
    options.mode === "sync"
      ? undefined
      : await (overrides.resolveToolchain ?? resolveToolchain)(root, env, run, {
          needAdb: needsDevice,
        })
  if (toolchain)
    Object.assign(env, toolchain.env, {
      NEXT_PUBLIC_PLATFORM: "mobile",
      COGNIA_MOBILE_DEV: options.mode === "dev" ? "1" : "0",
      COGNIA_NEXT_DIST_DIR: options.mode === "dev" ? ".next-mobile-dev" : ".next",
    })
  const serial = needsDevice
    ? selectDevice(await run(toolchain.adb, ["devices", "-l"], { capture: true }), options.serial)
    : undefined
  const adb = (args, extra = {}) => run(toolchain.adb, ["-s", serial, ...args], extra)
  const assemble = () =>
    run(
      toolchain.gradle,
      [
        ...(toolchain.gradleArgs ?? []),
        options.release ? ":app:assembleRelease" : ":app:assembleDebug",
        "--console=plain",
      ],
      { cwd: nativeDir }
    )
  const launch = async () => {
    await adb(["shell", "am", "force-stop", "com.cognia.mobile"])
    await adb(["shell", "am", "start", "-W", "-n", "com.cognia.mobile/.MainActivity"])
  }
  const install = async (
    apk = path.join(nativeDir, "app/build/outputs/apk/debug/app-debug.apk")
  ) => {
    await adb(["install", "-r", apk])
    await launch()
  }
  if (options.mode === "dev") {
    await run("pnpm", ["run", "mobile:prepare"])
    await (overrides.prepareDevWeb ?? prepareDevWeb)(root)
    const server = await (overrides.startDevServer ?? startDevServer)(
      root,
      env,
      options,
      signal,
      log
    )
    const mapping = `tcp:${options.port}`
    let ownedReverse = false
    try {
      const existing = parseReverse(await adb(["reverse", "--list"], { capture: true })).get(
        mapping
      )
      if (existing && existing !== mapping)
        throw new Error(`Device reverse ${mapping} already belongs to another destination`)
      if (!existing) {
        await adb(["reverse", "--no-rebind", mapping, mapping])
        ownedReverse = true
      }
      const cache = (overrides.devShellCache ?? devShellCache)(root, env, toolchain)
      // A fresh Android setup creates its default debug key during this task.
      // Initialize it before taking the input snapshot, then hash the key bytes.
      let syncedForSigning = false
      if (await cache.needsSigningKey?.()) {
        // Capacitor creates the Cordova Gradle project on a fresh checkout.
        await cap("sync")
        syncedForSigning = true
        await run(
          toolchain.gradle,
          [...(toolchain.gradleArgs ?? []), ":app:validateSigningDebug", "--console=plain"],
          { cwd: nativeDir }
        )
      }
      const inputs = await cache.fingerprint()
      let cached = await cache.find(inputs)
      if (!cached) {
        if (!syncedForSigning) await cap("sync")
        const nativeConfig = await (
          overrides.readConfig ?? (async (file) => JSON.parse(await readFile(file, "utf8")))
        )(configFile)
        if (
          nativeConfig.server?.url !== env.COGNIA_MOBILE_DEV_URL ||
          nativeConfig.server?.cleartext !== true
        )
          throw new Error("Capacitor failed to copy the dev configuration")
        const outputs = await cache.generated()
        // Incremental APK packaging can retain large holes after removing the
        // offline export. Recreate only the final archive; keep compiled caches.
        await rm(path.join(nativeDir, "app/build/outputs/apk/debug/app-debug.apk"), {
          force: true,
        })
        await assemble()
        cached = await cache.save(inputs, outputs)
      } else log("[mobile] Reusing verified native dev shell; sync and Gradle skipped")
      if (signal?.aborted) throw signal.reason
      const installed = await (overrides.installedDevShellMatches ?? installedDevShellMatches)(
        adb,
        cached.apkHash
      )
      // Recheck after all asynchronous validation, including the device query.
      if ((await cache.fingerprint()) !== inputs || !(await cache.find(inputs)))
        throw new Error("Native inputs changed before launch; restart the dev workflow")
      if (installed) {
        log("[mobile] Installed dev shell matches; installation skipped")
        await launch()
      } else await install(cached.apk)
      log(
        `[mobile] Live reload at ${env.COGNIA_MOBILE_DEV_URL}; Ctrl+C stops this session. Native changes require restarting it.`
      )
      await server.wait()
    } finally {
      await server.stop()
      if (ownedReverse) {
        const remaining = await adb(["reverse", "--list"], {
          capture: true,
          signal: undefined,
        }).catch(() => "")
        if (parseReverse(remaining).get(mapping) === mapping)
          await adb(["reverse", "--remove", mapping], { signal: undefined }).catch((error) =>
            log(`[mobile] Reverse cleanup failed: ${error.message}`)
          )
      }
    }
    return
  }
  if (options.mode !== "native") {
    await run("pnpm", ["run", "mobile:prepare"])
    const before = await fingerprint()
    await run("pnpm", ["exec", "next", "build", "--webpack"])
    await run("pnpm", ["run", "postbuild"])
    if ((await fingerprint()) !== before)
      throw new Error(
        "Web inputs changed during the build; refusing to stamp mixed-source artifacts"
      )
    const pruned = await (overrides.prune ?? pruneMobileAssets)(output)
    log(`[mobile] Removed ${pruned.removedFiles} non-runtime assets (${pruned.removedBytes} bytes)`)
    await stamp(output, before)
    await cap("sync")
    await verify(copied, before)
  } else {
    const current = await fingerprint()
    if (options.refresh !== "none") {
      await verify(output, current)
      await cap(options.refresh)
    }
    await verify(copied, current)
  }
  await verifyConfig(configFile)
  if (options.mode !== "sync") {
    // Full exports can remove large assets too. Recreate the archive so the ZIP
    // cannot retain padding from excluded files; native-only builds stay incremental.
    if (options.mode !== "native") {
      await rm(
        path.join(
          nativeDir,
          "app/build/outputs/apk",
          options.release ? "release/app-release-unsigned.apk" : "debug/app-debug.apk"
        ),
        { force: true }
      )
    }
    await assemble()
    if (needsDevice) await install()
    log(
      `[mobile] ${options.release ? "Unsigned release" : "Debug"} APK: ${path.join(nativeDir, `app/build/outputs/apk/${options.release ? "release/app-release-unsigned.apk" : "debug/app-debug.apk"}`)}`
    )
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  const lockPath = path.join(ROOT, "mobile/android/.cognia-build.lock")
  let lock
  try {
    lock = await open(lockPath, "wx")
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `Another mobile workflow owns ${lockPath}; stop it first. If it crashed, inspect and remove the stale lock.`
      )
    throw error
  }
  const controller = new AbortController()
  const interrupt = () => controller.abort(new Error("Android workflow interrupted"))
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, mode: options.mode, started: new Date().toISOString() })}\n`
    )
    await runAndroid(options, { signal: controller.signal })
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    await lock.close()
    await rm(lockPath)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[mobile] ${error.message}`)
    process.exitCode = 1
  })
}
