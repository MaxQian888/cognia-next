import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

const root = new URL("../node_modules/capacitor-zeroconf/", import.meta.url)
const source = (file) => readFileSync(new URL(file, root), "utf8")
const javaRoot = "android/src/main/java/io/trik/capacitor/zeroconf/"

// Verify installed dependency contracts so losing the pnpm patch cannot
// silently restore callback leaks or break a second discovery session.
test("Android registers every watch and refreshes interfaces for each new browser", () => {
  const text = source(`${javaRoot}ZeroConf.java`)
  const watch = text.slice(text.indexOf("public void watchService"), text.indexOf("public void unwatchService"))
  assert.match(watch, /if \(browserManager == null\) \{\s*refreshAddresses\(\)/)
  assert.match(watch, /\}\s*browserManager\.watch\(type, domain, callback\)/)
  assert.match(text, /if \(browserManager\.calls\.isEmpty\(\)\) close\(\)/)
  assert.match(text, /browserManager = null;\s*bm\.close\(\)/)
  assert.match(text, /private void close\(\) throws IOException \{\s*lock\.release\(\)/)
})

test("Android releases partial browser resources when construction fails", () => {
  const text = source(`${javaRoot}ZeroConf.java`)
  assert.match(text, /catch \(IOException \| RuntimeException error\) \{\s*try \{ close\(\); \}/)
  assert.match(text, /browsers\.clear\(\);\s*if \(failure != null\) throw failure/)
  assert.match(text, /ConcurrentHashMap/)
})

test("Android retires saved callbacks and ignores events from replaced calls", () => {
  const text = source(`${javaRoot}ZeroConfPlugin.java`)
  assert.match(text, /previous\.setKeepAlive\(false\);\s*previous\.resolve\(\);\s*previous\.release\(getBridge\(\)\)/)
  assert.match(text, /if \(watchCalls\.get\(key\) != call\) return/)
  const unwatch = text.slice(text.indexOf("public void unwatch("), text.indexOf("public void close("))
  assert.match(unwatch, /releaseWatch\(type \+ domain\)/)
})

test("iOS completes unwatch without waiting for the wrong NetService delegate", () => {
  const text = source("ios/Plugin/ZeroConf.swift")
  assert.match(text, /browser\.unwatch\(nil\)\s*callback\(nil\)/)
  assert.match(text, /browsers\[type \+ domain\]\?\.unwatch\(nil\)/)
  const stop = text.slice(text.indexOf("func unwatch(_ unwatchCallback:"), text.indexOf("func destroy()", text.indexOf("func unwatch(_ unwatchCallback:")))
  for (const operation of ["watchCallback = nil", "nsb?.delegate = nil", "nsb?.stop()", "nsb = nil", "service.delegate = nil", "service.stop()", "services.removeAll()"]) {
    assert.ok(stop.includes(operation), operation)
  }
})

test("iOS releases saved watch callbacks and ignores replaced calls", () => {
  const text = source("ios/Plugin/ZeroConfPlugin.swift")
  assert.match(text, /previous\.keepAlive = false\s*previous\.resolve\(\)\s*bridge\?\.releaseCall\(previous\)/)
  assert.match(text, /self\.watchCalls\[key\] === call/)
  assert.match(text, /self\.releaseWatch\(type \+ domain\)/)
})
