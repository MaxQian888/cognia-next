import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"

import {
  parseArgs,
  selectDevice,
  parseReverse,
  runAndroid,
  resolveToolchain,
  commandRunner,
  prepareDevWeb,
  startDevServer,
} from "./android.mjs"
import {
  stampArtifact,
  verifyArtifact,
  verifyOfflineConfig,
  sourceFingerprint,
} from "./android-artifact.mjs"
import { checkAndroidRelease } from "./check-android-release.mjs"
import { devShellCache } from "./android-dev-shell.mjs"

async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

for (const scenario of ["timeout", "early-exit", "later-exit", "abort-pending", "abort-ready"]) {
  test(`real dev subprocess ${scenario} releases its listener and process`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-dev-lifecycle-"))
    const port = await unusedPort()
    const controller = new AbortController()
    let server
    try {
      const script = path.join(root, "pnpm.cjs")
      await writeFile(
        script,
        `
        require('node:fs').writeFileSync('child.pid', String(process.pid));
        const mode = process.env.COGNIA_TEST_MODE;
        if (mode === 'early-exit') process.exit(7);
        require('node:http').createServer((req, res) => {
          res.statusCode = ['timeout', 'abort-pending'].includes(mode) ? 503 : 200;
          res.end('fixture');
          if (mode === 'later-exit') setTimeout(() => process.exit(9), 100);
        }).listen(Number(process.argv.at(-1)), '127.0.0.1');
      `
      )
      const pending = startDevServer(
        root,
        {
          ...process.env,
          npm_execpath: script,
          COGNIA_TEST_MODE: scenario,
        },
        { port, bundler: "webpack", timeoutMs: scenario === "timeout" ? 800 : 5000 },
        controller.signal,
        () => {}
      )
      if (scenario === "abort-pending") {
        const timer = setTimeout(() => controller.abort(new Error("test cancellation")), 400)
        try {
          await assert.rejects(pending, /test cancellation/)
        } finally {
          clearTimeout(timer)
        }
      } else if (scenario === "timeout") {
        await assert.rejects(pending, /did not become ready.*HTTP 503/)
      } else if (scenario === "early-exit") {
        await assert.rejects(pending, /stopped \(7\)/)
      } else {
        server = await pending
        if (scenario === "later-exit") await assert.rejects(server.wait(), /stopped \(9\)/)
        else {
          controller.abort(new Error("test cancellation"))
          await server.wait()
        }
        await server.stop()
      }
      const pid = Number(await readFile(path.join(root, "child.pid"), "utf8"))
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
      const probe = net.createServer()
      await new Promise((resolve, reject) => {
        probe.once("error", reject)
        probe.listen(port, "127.0.0.1", () => probe.close(resolve))
      })
    } finally {
      controller.abort(new Error("test cleanup"))
      await server?.stop()
      await delay(20)
      await rm(root, { recursive: true, force: true })
    }
  })
}
import ts from "typescript"
import vm from "node:vm"
import { readFile } from "node:fs/promises"

test("options reject ambiguous or unsafe workflows", () => {
  assert.deepEqual(parseArgs(["dev"]), {
    mode: "dev",
    port: 3002,
    timeoutMs: 600_000,
    bundler: "webpack",
    refresh: "sync",
    install: true,
    release: false,
    serial: undefined,
    help: false,
  })
  for (const args of [
    ["dev", "--port=0"],
    ["native", "--refresh=bad"],
    ["dev", "--release"],
    ["build", "--unknown"],
    ["dev", "--port=3x"],
  ]) {
    assert.throws(() => parseArgs(args))
  }
})

test("device targeting requires one authorized device and honors serial", () => {
  const listing = "List of devices attached\na device product:p\nb unauthorized\n"
  assert.equal(selectDevice(listing), "a")
  assert.throws(() => selectDevice(listing, "b"), /not authorized/)
  assert.throws(() => selectDevice("a device\nc device"), /multiple/)
  assert.throws(() => selectDevice("a offline"), /No authorized/)
  assert.deepEqual([...parseReverse("UsbFfs tcp:3002 tcp:3002\n")], [["tcp:3002", "tcp:3002"]])
})

test("artifact provenance detects modified files, incomplete copy, stale inputs, and wrong targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-mobile-artifact-"))
  try {
    await mkdir(path.join(root, "out"))
    await writeFile(path.join(root, "out/index.html"), "hello")
    await writeFile(path.join(root, "out/app.js"), "script")
    await stampArtifact(path.join(root, "out"), "source-one")
    await verifyArtifact(path.join(root, "out"), "source-one")
    await assert.rejects(verifyArtifact(path.join(root, "out"), "source-two"), /stale/)
    await writeFile(path.join(root, "out/app.js"), "tamper")
    await assert.rejects(verifyArtifact(path.join(root, "out"), "source-one"), /app.js/)
    await rm(path.join(root, "out/index.html"))
    await assert.rejects(verifyArtifact(path.join(root, "out"), "source-one"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact verification rejects extra assets and symlink ancestor escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-artifact-closure-"))
  try {
    const output = path.join(root, "out")
    await mkdir(output)
    await writeFile(path.join(output, "index.html"), "hello")
    await stampArtifact(output, "inputs")
    await writeFile(path.join(output, "cordova.js"), "generated by cap")
    await verifyArtifact(output, "inputs")
    await writeFile(path.join(output, "stale-desktop.js"), "desktop")
    await assert.rejects(verifyArtifact(output, "inputs"), /Unexpected.*stale-desktop/)
    await rm(path.join(output, "stale-desktop.js"))
    await symlink(root, path.join(output, "escape"), "dir")
    await assert.rejects(verifyArtifact(output, "inputs"), /symlink/)
    await rm(path.join(output, "escape"))
    await symlink(output, path.join(root, "linked"), "dir")
    await assert.rejects(verifyArtifact(path.join(root, "linked"), "inputs"), /real directory/)
    const artifactFile = path.join(output, "cognia-mobile-artifact.json")
    const artifact = JSON.parse(await readFile(artifactFile, "utf8"))
    artifact.platform = "web"
    await writeFile(artifactFile, JSON.stringify(artifact))
    await assert.rejects(verifyArtifact(output, "inputs"), /Invalid mobile/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("fresh dev shell is small, needs no out, and refuses to overwrite an unowned file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-dev-web-"))
  try {
    await prepareDevWeb(root)
    await prepareDevWeb(root)
    const file = path.join(root, "mobile/.dev-web/index.html")
    assert.ok((await readFile(file, "utf8")).length < 1024)
    await writeFile(file, "user content")
    await assert.rejects(prepareDevWeb(root), /unowned/)
    assert.equal(await readFile(file, "utf8"), "user content")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("native refresh policy never rebuilds web and verifies before Gradle", async () => {
  for (const refresh of ["none", "copy", "sync"]) {
    const calls = []
    const deps = fakeDependencies(calls)
    await runAndroid(parseArgs(["native", `--refresh=${refresh}`, "--no-install"]), deps)
    assert.equal(
      calls.some((x) => x.includes("next")),
      false
    )
    assert.equal(calls.filter((x) => x.startsWith("verify:")).length, refresh === "none" ? 1 : 2)
    assert.equal(
      calls.some((x) => x.includes(`cap ${refresh} android`)),
      refresh !== "none"
    )
    assert.ok(
      calls.findIndex((x) => x.startsWith("verify:")) <
        calls.findIndex((x) => x.includes("assembleDebug"))
    )
  }
})

test("build stamps only a successful unchanged mobile build and does not target devices", async () => {
  const calls = []
  await runAndroid(parseArgs(["build"]), fakeDependencies(calls))
  assert.ok(calls.some((x) => x.includes("next build --webpack")))
  assert.ok(calls.includes("stamp"))
  assert.ok(calls.indexOf("prune") < calls.indexOf("stamp"))
  assert.equal(
    calls.some((x) => x.includes(" devices")),
    false
  )
  const failing = fakeDependencies([])
  failing.run = async (_cmd, args) => {
    if (args.includes("build")) throw new Error("build failed")
    return ""
  }
  let stamped = false
  failing.stamp = async () => {
    stamped = true
  }
  await assert.rejects(runAndroid(parseArgs(["build"]), failing), /build failed/)
  assert.equal(stamped, false)
})

test("unsafe asset exclusions fail before stamping, native copy or assembly", async () => {
  const calls = []
  const deps = fakeDependencies(calls)
  deps.prune = async () => {
    throw new Error("Mobile runtime asset reference")
  }
  await assert.rejects(runAndroid(parseArgs(["build"]), deps), /runtime asset reference/)
  assert.equal(calls.includes("stamp"), false)
  assert.equal(
    calls.some((call) => /cap sync|assembleDebug/.test(call)),
    false
  )
})

test("changed inputs during production build refuse stamping or native copy", async () => {
  const calls = []
  const deps = fakeDependencies(calls)
  let count = 0
  deps.fingerprint = async () => String(count++)
  await assert.rejects(runAndroid(parseArgs(["sync"]), deps), /changed during/)
  assert.equal(calls.includes("stamp"), false)
  assert.equal(
    calls.some((call) => call.includes("cap sync")),
    false
  )
})

test("failed asset verification prevents Gradle and install even if cap sync returns success", async () => {
  const calls = []
  const deps = fakeDependencies(calls)
  deps.verify = async () => {
    throw new Error("copy mismatch")
  }
  await assert.rejects(runAndroid(parseArgs(["build"]), deps), /copy mismatch/)
  assert.equal(
    calls.some((call) => call.includes("assemble")),
    false
  )
})

test("dev owns its processes and reverse mapping, preserves pre-existing mappings, and cleans up on failure", async () => {
  for (const existing of [false, true]) {
    const calls = []
    const deps = fakeDependencies(calls)
    let stopped = false
    deps.startDevServer = async (_root, env) => {
      assert.equal(env.COGNIA_MOBILE_DEV_URL, "http://localhost:3002")
      assert.equal(env.COGNIA_NEXT_DIST_DIR, ".next-mobile-dev")
      return {
        wait: async () => {
          throw new Error("server died")
        },
        stop: async () => {
          stopped = true
        },
      }
    }
    deps.readConfig = async () => ({ server: { url: "http://localhost:3002", cleartext: true } })
    deps.run = async (command, args, options) => {
      calls.push(`${command} ${args.join(" ")}`)
      if (args[0] === "devices") return "phone device"
      if (args.includes("--list"))
        return existing || calls.some((call) => call.includes("--no-rebind"))
          ? "UsbFfs tcp:3002 tcp:3002"
          : ""
      assert.equal(options.env.NEXT_PUBLIC_PLATFORM, "mobile")
      return ""
    }
    await assert.rejects(runAndroid(parseArgs(["dev"]), deps), /server died/)
    assert.equal(stopped, true)
    assert.equal(
      calls.some((call) => call.includes("reverse --remove")),
      !existing
    )
    assert.equal(
      calls.some((call) => call.includes("next build")),
      false
    )
    assert.equal(calls.filter((call) => call.includes("install -r")).length, 1)
  }
})

for (const mode of ["dev", "build"])
  test(`${mode} repacks only the final APK while preserving native compilation caches`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-dev-repack-"))
    const apk = path.join(root, "mobile/android/app/build/outputs/apk/debug/app-debug.apk")
    const cache = path.join(root, "mobile/android/app/build/intermediates/compiled-cache")
    try {
      await mkdir(path.dirname(apk), { recursive: true })
      await mkdir(path.dirname(cache), { recursive: true })
      await writeFile(apk, "old offline APK with removed-entry padding")
      await writeFile(cache, "compiled native code")
      const deps = fakeDependencies([])
      deps.root = root
      deps.startDevServer = async () => ({ wait: async () => {}, stop: async () => {} })
      deps.readConfig = async () => ({ server: { url: "http://localhost:3002", cleartext: true } })
      deps.run = async (_command, args) => {
        if (args[0] === "devices") return "phone device"
        if (args.includes(":app:assembleDebug")) {
          await assert.rejects(readFile(apk), { code: "ENOENT" })
          assert.equal(await readFile(cache, "utf8"), "compiled native code")
          await writeFile(apk, "fresh small APK")
        }
        return ""
      }
      await runAndroid(parseArgs([mode]), deps)
      assert.equal(await readFile(apk, "utf8"), "fresh small APK")
      deps.run = async () => ""
      await runAndroid(parseArgs(["native", "--refresh=none", "--no-install"]), deps)
      assert.equal(await readFile(apk, "utf8"), "fresh small APK")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

test("dev reuses valid local shell and only installs when device bytes differ", async () => {
  for (const installed of [true, false]) {
    const calls = []
    const deps = fakeDependencies(calls)
    deps.startDevServer = async () => ({ wait: async () => {}, stop: async () => {} })
    deps.devShellCache = () => ({
      fingerprint: async () => "inputs",
      find: async () => ({
        apkHash: "verified",
        apk: "/fixture/.cache/mobile-dev-shell/verified.apk",
      }),
      save: async () => {
        throw new Error("unexpected rebuild")
      },
    })
    deps.installedDevShellMatches = async (_adb, hash) => {
      assert.equal(hash, "verified")
      return installed
    }
    deps.run = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`)
      return args[0] === "devices" ? "phone device" : ""
    }
    await runAndroid(parseArgs(["dev"]), deps)
    assert.equal(
      calls.some((call) => /cap sync|assembleDebug/.test(call)),
      false
    )
    assert.equal(
      calls.some((call) => call.includes("install -r")),
      !installed
    )
    if (!installed)
      assert.ok(
        calls.some((call) =>
          call.endsWith("install -r /fixture/.cache/mobile-dev-shell/verified.apk")
        )
      )
    assert.equal(
      calls.some((call) => call.includes("am start -W")),
      true
    )
  }
})

test("offline rebuild does not prevent reinstalling the separately verified dev APK", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-dev-offline-reuse-"))
  try {
    const env = { COGNIA_MOBILE_DEV: "1", COGNIA_MOBILE_DEV_URL: "http://localhost:3002" }
    const cache = devShellCache(root, env, { javaVersion: undefined })
    const config = {
      appId: "com.cognia.mobile",
      server: { url: env.COGNIA_MOBILE_DEV_URL, cleartext: true },
      android: { webContentsDebuggingEnabled: true },
    }
    const assets = path.join(root, "mobile/android/app/src/main/assets")
    await mkdir(assets, { recursive: true })
    await writeFile(path.join(root, "mobile/package.json"), "{}")
    await writeFile(path.join(assets, "capacitor.config.json"), JSON.stringify(config))
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    zip.file("assets/capacitor.config.json", JSON.stringify(config))
    zip.file("assets/public/index.html", "<!-- Generated by Cognia Android dev workflow. -->")
    await mkdir(path.dirname(cache.sourceApk), { recursive: true })
    const devBytes = await zip.generateAsync({ type: "nodebuffer" })
    await writeFile(cache.sourceApk, devBytes)
    const cached = await cache.save(await cache.fingerprint(), await cache.generated())
    await writeFile(cache.sourceApk, "offline APK")
    await writeFile(
      path.join(assets, "capacitor.config.json"),
      JSON.stringify({ ...config, server: {} })
    )
    const calls = []
    const deps = fakeDependencies(calls)
    deps.root = root
    deps.devShellCache = () => ({ ...cache, needsSigningKey: async () => false })
    deps.startDevServer = async () => ({ wait: async () => {}, stop: async () => {} })
    deps.installedDevShellMatches = async (_adb, hash) => {
      assert.equal(hash, cached.apkHash)
      return false
    }
    deps.run = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`)
      if (args[0] === "devices") return "phone device"
      if (args.includes("install")) {
        assert.equal(args.at(-1), cached.apk)
        assert.deepEqual(await readFile(args.at(-1)), devBytes)
      }
      return ""
    }
    await runAndroid(parseArgs(["dev"]), deps)
    assert.equal(
      calls.some((call) => /cap sync|assembleDebug/.test(call)),
      false
    )
    assert.equal(
      calls.some((call) => call.includes("install -r")),
      true
    )
    assert.equal(await readFile(cache.sourceApk, "utf8"), "offline APK")
    assert.deepEqual(
      JSON.parse(await readFile(path.join(assets, "capacitor.config.json"), "utf8")).server,
      {}
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("first dev build initializes the default signing key before fingerprinting", async () => {
  const calls = []
  const deps = fakeDependencies(calls)
  deps.startDevServer = async () => ({ wait: async () => {}, stop: async () => {} })
  deps.readConfig = async () => ({ server: { url: "http://localhost:3002", cleartext: true } })
  deps.run = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`)
    return args[0] === "devices" ? "phone device" : ""
  }
  const createCache = deps.devShellCache
  deps.devShellCache = (...args) => {
    const cache = createCache(...args)
    return {
      ...cache,
      needsSigningKey: async () => true,
      fingerprint: async () => {
        assert.ok(calls.some((call) => call.includes(":app:validateSigningDebug")))
        return cache.fingerprint()
      },
    }
  }
  await runAndroid(parseArgs(["dev"]), deps)
  assert.equal(calls.filter((call) => call.includes(":app:validateSigningDebug")).length, 1)
  assert.equal(calls.filter((call) => call.includes("cap sync")).length, 1)
  assert.ok(
    calls.findIndex((call) => call.includes("cap sync")) <
      calls.findIndex((call) => call.includes(":app:validateSigningDebug"))
  )
})

test("dev refuses launching or installing after concurrent native edits", async () => {
  const calls = []
  const deps = fakeDependencies(calls)
  let queries = 0
  deps.startDevServer = async () => ({ wait: async () => {}, stop: async () => {} })
  deps.devShellCache = () => ({
    fingerprint: async () => String(queries++),
    find: async () => ({
      apkHash: "verified",
      apk: "/fixture/.cache/mobile-dev-shell/verified.apk",
    }),
  })
  deps.installedDevShellMatches = async () => true
  deps.run = async (command, args) => {
    calls.push(`${command} ${args.join(" ")}`)
    return args[0] === "devices" ? "phone device" : ""
  }
  await assert.rejects(runAndroid(parseArgs(["dev"]), deps), /Native inputs changed/)
  assert.equal(
    calls.some((call) => /install -r|am start/.test(call)),
    false
  )
})

test("dev refuses reverse conflicts and failed config copies without installing", async () => {
  for (const conflict of [true, false]) {
    const calls = []
    const deps = fakeDependencies(calls)
    let stopped = false
    deps.startDevServer = async () => ({
      wait: async () => {},
      stop: async () => {
        stopped = true
      },
    })
    deps.readConfig = async () => ({ server: {} })
    deps.run = async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`)
      if (args[0] === "devices") return "phone device"
      if (args.includes("--list")) return conflict ? "UsbFfs tcp:3002 tcp:9999" : ""
      return ""
    }
    await assert.rejects(
      runAndroid(parseArgs(["dev"]), deps),
      conflict ? /another destination/ : /dev configuration/
    )
    assert.equal(stopped, true)
    assert.equal(
      calls.some((call) => call.includes("install -r")),
      false
    )
  }
})

test("toolchain discovers explicit JDK and SDK on macOS, Linux and Windows", async () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const suffix = platform === "win32" ? ".exe" : ""
    const chain = await resolveToolchain(
      "/root",
      { JAVA_HOME: "/jdk", ANDROID_HOME: "/sdk" },
      async (command) => {
        if (command.includes("java_home")) throw new Error("not installed")
        return "javac 21.0.9\n"
      },
      {
        platform,
        read: async () => "",
        canExecute: async (file) =>
          file === `/jdk/bin/javac${suffix}` ||
          file === `/sdk/platform-tools/adb${suffix}` ||
          file.endsWith("gradlew.bat"),
      }
    )
    assert.equal(chain.env.JAVA_HOME, "/jdk")
    assert.equal(chain.env.ANDROID_HOME, "/sdk")
    assert.equal(chain.gradle, platform === "win32" ? "/root/mobile/android/gradlew.bat" : "sh")
  }
  await assert.rejects(
    resolveToolchain("/root", {}, async () => "javac 17", {
      read: async () => "",
      canExecute: async () => true,
    }),
    /JDK 21/
  )
})

test("Capacitor configuration strictly validates dev flags and loopback URLs", async () => {
  const source = await readFile(new URL("../capacitor.config.ts", import.meta.url), "utf8")
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  const config = (env) => {
    const exports = {}
    vm.runInNewContext(js, { exports, process: { env }, URL })
    return exports.default
  }
  assert.equal(config({ COGNIA_MOBILE_DEV: "0" }).server.url, undefined)
  assert.equal(config({ COGNIA_MOBILE_DEV: "1" }).server.url, "http://localhost:3002")
  for (const env of [
    { COGNIA_MOBILE_DEV: "true" },
    { COGNIA_MOBILE_DEV_URL: "http://localhost:3002" },
    ...[
      "https://localhost:3002",
      "http://example.com:3002",
      "http://user:pass@localhost:3002",
      "http://localhost:3002/path",
      "http://localhost:3002/?secret=x",
      "http://localhost:80",
      "not-a-url",
    ].map((url) => ({ COGNIA_MOBILE_DEV: "1", COGNIA_MOBILE_DEV_URL: url })),
  ])
    assert.throws(() => config(env))
})

test("release guard rejects live reload and modified native assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-release-"))
  try {
    await mkdir(path.join(root, "public"))
    await writeFile(path.join(root, "public/index.html"), "offline")
    await stampArtifact(path.join(root, "public"), "inputs")
    const file = path.join(root, "capacitor.config.json")
    await writeFile(file, JSON.stringify({ appId: "com.cognia.mobile", server: {} }))
    await checkAndroidRelease(root)
    await writeFile(
      file,
      JSON.stringify({ appId: "com.cognia.mobile", server: { url: "http://localhost:3002" } })
    )
    await assert.rejects(checkAndroidRelease(root), /live-reload/)
    await writeFile(
      file,
      JSON.stringify({ appId: "com.cognia.mobile", android: { webContentsDebuggingEnabled: true } })
    )
    await assert.rejects(verifyOfflineConfig(file), /live-reload/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("source fingerprint includes uncommitted contents and env without persisting secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-input-"))
  try {
    await mkdir(path.join(root, "app"))
    await writeFile(path.join(root, "app/page.tsx"), "first")
    await writeFile(path.join(root, ".env.local"), "SECRET=one")
    const run = async () => "app/page.tsx\0"
    const first = await sourceFingerprint(root, run, { NEXT_PUBLIC_PLATFORM: "mobile" })
    await writeFile(path.join(root, "app/page.tsx"), "second")
    const second = await sourceFingerprint(root, run, { NEXT_PUBLIC_PLATFORM: "mobile" })
    assert.notEqual(first, second)
    assert.notEqual(second, await sourceFingerprint(root, run, { NEXT_PUBLIC_PLATFORM: "web" }))
    await writeFile(path.join(root, ".env.local"), "SECRET=two")
    assert.notEqual(second, await sourceFingerprint(root, run, { NEXT_PUBLIC_PLATFORM: "mobile" }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("command runner propagates failures and aborts its own child", async () => {
  await assert.rejects(
    commandRunner(process.execPath, ["-e", "process.exit(7)"], { capture: true }),
    /failed \(7\)/
  )
  const controller = new AbortController()
  const promise = commandRunner(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    capture: true,
    signal: controller.signal,
  })
  controller.abort(new Error("stop"))
  await assert.rejects(promise)
})

function fakeDependencies(calls) {
  return {
    root: "/fixture",
    env: {},
    run: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`)
      return ""
    },
    resolveToolchain: async () => ({ adb: "adb", env: {}, gradle: "gradlew" }),
    fingerprint: async () => "inputs",
    prune: async () => {
      calls.push("prune")
      return { removedFiles: 1, removedBytes: 100 }
    },
    stamp: async () => {
      calls.push("stamp")
    },
    verify: async (directory) => {
      calls.push(`verify:${directory}`)
    },
    verifyConfig: async () => {
      calls.push("verify-config")
    },
    prepareDevWeb: async () => {},
    devShellCache: () => {
      let cached = null
      return {
        fingerprint: async () => "native-inputs",
        generated: async () => "native-outputs",
        find: async () => cached,
        save: async () => (cached = { apkHash: "hash" }),
      }
    },
    log: () => {},
  }
}
