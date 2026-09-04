import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import { NATIVE_HOSTS } from "./ensure-native-hosts.mjs"
import {
  HOST_BUILD_HINTS,
  HOST_PATH_OVERRIDES,
  missingNativeHosts,
  nativeHostFileNames,
  nativeHostFiles,
} from "./native-host-files.mjs"

test("describes every helper the build table names", () => {
  // The set that ships is the set that gets built. A helper present in one and
  // not the other is a layout that starts and then refuses at runtime.
  assert.deepEqual(
    nativeHostFiles("/repo", { env: {} }).map((f) => f.bin),
    NATIVE_HOSTS.map((h) => h.bin)
  )
})

test("every helper has an override env var and a build hint", () => {
  for (const host of NATIVE_HOSTS) {
    assert.ok(HOST_PATH_OVERRIDES[host.bin], `${host.bin} has no path override env var`)
    assert.ok(HOST_BUILD_HINTS[host.bin], `${host.bin} has no build hint`)
  }
})

test("resolves from target/release and applies the platform suffix", () => {
  const files = nativeHostFiles("/repo", { suffix: ".exe", env: {} })
  const launcher = files.find((f) => f.bin === "cognia-external-agent-launcher")
  assert.equal(launcher.name, "cognia-external-agent-launcher.exe")
  assert.equal(
    launcher.source,
    path.join("/repo", "target", "release", "cognia-external-agent-launcher.exe")
  )
  assert.equal(launcher.overridden, false)
})

test("an env override wins over target/release and is reported as overridden", () => {
  // Cross-compiling runners set these because target/release on the build host
  // holds the wrong architecture.
  const files = nativeHostFiles("/repo", {
    env: { COGNIA_SANDBOX_EXEC_PATH: "/prebuilt/cognia-sandbox-exec" },
  })
  const sandbox = files.find((f) => f.bin === "cognia-sandbox-exec")
  assert.equal(sandbox.source, "/prebuilt/cognia-sandbox-exec")
  assert.equal(sandbox.overridden, true)
})

test("nativeHostFileNames matches the resolved names", () => {
  assert.deepEqual(
    nativeHostFileNames(".exe"),
    nativeHostFiles("/repo", { suffix: ".exe", env: {} }).map((f) => f.name)
  )
})

test("missingNativeHosts names what is absent and how to build it", () => {
  const files = nativeHostFiles("/repo", { env: {} })
  const missing = missingNativeHosts(files, (source) => !source.includes("sandbox-exec"))
  assert.deepEqual(
    missing.map((f) => f.bin),
    ["cognia-sandbox-exec"]
  )
  assert.equal(missing[0].hint, "pnpm cli:sandbox-exec:build")
})

test("missingNativeHosts is empty when every source exists", () => {
  const files = nativeHostFiles("/repo", { env: {} })
  assert.deepEqual(missingNativeHosts(files, () => true), [])
})
