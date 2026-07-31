/**
 * Regression coverage for scripts/dev/clean-app-databases.mjs.
 *
 * The path-derivation and delete logic are exported as pure-ish functions with
 * injected `platform` / `home` / `env` / fs seams, so we exercise every branch
 * without touching the real user-data directories.
 *
 * Run with: node --test scripts/dev/clean-app-databases.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { appStorageTargets, cleanAppDatabases, readTauriIdentity } from "./clean-app-databases.mjs"

const IDENTITY = {
  identifier: "com.cognia.desktop",
  productName: "Cognia",
  binName: "cognia-next",
}

test("macOS targets cover every WebKit origin, Caches, and the app-support dir", () => {
  const targets = appStorageTargets({
    platform: "darwin",
    home: "/Users/test",
    env: {},
    ...IDENTITY,
  })

  // WKWebView storage for all three candidate app-folder names (dev binary,
  // productName, bundle identifier).
  assert.ok(targets.includes("/Users/test/Library/WebKit/cognia-next"))
  assert.ok(targets.includes("/Users/test/Library/WebKit/Cognia"))
  assert.ok(targets.includes("/Users/test/Library/WebKit/com.cognia.desktop"))
  // WKWebView disk caches.
  assert.ok(targets.includes("/Users/test/Library/Caches/cognia-next"))
  // Native app data (identifier only — the space in the path is intentional).
  assert.ok(targets.includes("/Users/test/Library/Application Support/com.cognia.desktop"))
})

test("duplicate candidate names collapse to a single WebKit entry", () => {
  const targets = appStorageTargets({
    platform: "darwin",
    home: "/Users/test",
    env: {},
    identifier: "dup",
    productName: "dup",
    binName: "dup",
  })
  const webkit = targets.filter((t) => t === "/Users/test/Library/WebKit/dup")
  assert.equal(webkit.length, 1)
})

test("Windows targets use LOCALAPPDATA/APPDATA and the EBWebView folder", () => {
  const targets = appStorageTargets({
    platform: "win32",
    home: "C:\\Users\\me",
    env: {
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    },
    ...IDENTITY,
  })

  assert.ok(targets.includes("C:\\Users\\me\\AppData\\Local\\cognia-next\\EBWebView"))
  assert.ok(targets.includes("C:\\Users\\me\\AppData\\Roaming\\com.cognia.desktop"))
})

test("Windows falls back to home-relative dirs when env vars are absent", () => {
  const targets = appStorageTargets({
    platform: "win32",
    home: "C:\\Users\\me",
    env: {},
    ...IDENTITY,
  })
  assert.ok(targets.includes("C:\\Users\\me\\AppData\\Local\\cognia-next\\EBWebView"))
  assert.ok(targets.includes("C:\\Users\\me\\AppData\\Roaming\\com.cognia.desktop"))
})

test("Linux targets honour XDG dirs and cover the WebKitGTK data/cache roots", () => {
  const targets = appStorageTargets({
    platform: "linux",
    home: "/home/test",
    env: {
      XDG_DATA_HOME: "/home/test/.local/share",
      XDG_CACHE_HOME: "/home/test/.cache",
    },
    ...IDENTITY,
  })

  assert.ok(targets.includes("/home/test/.local/share/cognia-next"))
  assert.ok(targets.includes("/home/test/.cache/cognia-next"))
  // Native data dir == identifier under XDG_DATA_HOME.
  assert.ok(targets.includes("/home/test/.local/share/com.cognia.desktop"))
})

test("Linux falls back to ~/.local/share and ~/.cache without XDG vars", () => {
  const targets = appStorageTargets({
    platform: "linux",
    home: "/home/test",
    env: {},
    ...IDENTITY,
  })
  assert.ok(targets.includes("/home/test/.local/share/cognia-next"))
  assert.ok(targets.includes("/home/test/.cache/cognia-next"))
})

test("unknown platforms yield no targets", () => {
  const targets = appStorageTargets({
    platform: "aix",
    home: "/home/test",
    env: {},
    ...IDENTITY,
  })
  assert.deepEqual(targets, [])
})

test("cleanAppDatabases removes only existing targets", () => {
  const present = new Set(["/a", "/c"])
  const removed = []
  const messages = []
  const result = cleanAppDatabases({
    targets: ["/a", "/b", "/c"],
    exists: (t) => present.has(t),
    rm: (t) => removed.push(t),
    log: (m) => messages.push(m),
  })

  assert.deepEqual(removed, ["/a", "/c"])
  assert.deepEqual(result.removed, ["/a", "/c"])
  assert.deepEqual(result.skipped, ["/b"])
  assert.deepEqual(result.failed, [])
})

test("dry-run reports would-remove without calling rm", () => {
  let rmCalls = 0
  const messages = []
  const result = cleanAppDatabases({
    targets: ["/a", "/b"],
    exists: () => true,
    rm: () => {
      rmCalls += 1
    },
    log: (m) => messages.push(m),
    dryRun: true,
  })

  assert.equal(rmCalls, 0)
  assert.deepEqual(result.removed, ["/a", "/b"])
  assert.ok(messages.some((m) => /would remove/.test(m)))
})

test("a failing rm is captured, does not throw, and does not stop the loop", () => {
  const removed = []
  const result = cleanAppDatabases({
    targets: ["/a", "/b", "/c"],
    exists: () => true,
    rm: (t) => {
      if (t === "/b") throw new Error("EBUSY: locked")
      removed.push(t)
    },
    log: () => {},
  })

  assert.deepEqual(removed, ["/a", "/c"])
  assert.deepEqual(result.removed, ["/a", "/c"])
  assert.equal(result.failed.length, 1)
  assert.equal(result.failed[0].target, "/b")
  assert.match(result.failed[0].error, /EBUSY/)
})

test("readTauriIdentity parses identifier + productName from the config", () => {
  const conf = JSON.stringify({
    identifier: "com.example.app",
    productName: "Example",
  })
  const identity = readTauriIdentity("/repo", () => conf)
  assert.deepEqual(identity, {
    identifier: "com.example.app",
    productName: "Example",
  })
})

test("readTauriIdentity falls back to constants on read/parse failure", () => {
  const identity = readTauriIdentity("/repo", () => {
    throw new Error("ENOENT")
  })
  assert.equal(identity.identifier, "com.cognia.desktop")
  assert.equal(identity.productName, "Cognia")
})

test("readTauriIdentity falls back per-field when a field is missing/blank", () => {
  const conf = JSON.stringify({ identifier: "", productName: "OnlyName" })
  const identity = readTauriIdentity("/repo", () => conf)
  assert.equal(identity.identifier, "com.cognia.desktop")
  assert.equal(identity.productName, "OnlyName")
})
