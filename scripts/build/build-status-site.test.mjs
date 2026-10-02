import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  buildStatusSite,
  collectCssRefs,
  collectHtmlRefs,
  collectLocalLinks,
  collectScriptRefs,
  crawlLocales,
  isRootPageFile,
  locateStatusHtml,
  normalizeStaticRef,
  parseArgs,
  staticClosure,
} from "./build-status-site.mjs"

function fakeExport() {
  const out = mkdtempSync(path.join(tmpdir(), "status-out-"))
  const write = (relative, body) => {
    const file = path.join(out, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  write(
    "status.html",
    '<html><head><link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/_next/static/css/a.css"></head>' +
      '<body><script src="/_next/static/chunks/main.js"></script>' +
      '<script>self.__next_f.push([1,"\\u002F_next\\u002Fstatic\\u002Fchunks\\u002Fpage.js"])</script></body></html>'
  )
  write("_next/static/css/a.css", "@font-face{src:url(../media/font.woff2)}body{background:url(data:image/png;base64,AAAA)}")
  write("_next/static/media/font.woff2", "font")
  write("_next/static/chunks/main.js", 'load("static/chunks/lazy.js")')
  write("_next/static/chunks/page.js", "page")
  write("_next/static/chunks/lazy.js", "lazy")
  write("_next/static/chunks/other-route.js", "must not be copied")
  write("_next/static/BUILD/_buildManifest.js", "manifest")
  write("favicon.ico", "ico")
  write("status.txt", "rsc")
  write("status/__next._tree.txt", "rsc tree")
  write("settings.html", "<html>private route</html>")
  return out
}

test("parseArgs accepts the documented options only", () => {
  assert.equal(parseArgs(["--no-crawl"]).crawl, false)
  assert.equal(parseArgs(["--dest", "/tmp/x"]).dest, "/tmp/x")
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/)
})

test("normalizeStaticRef keeps only clean /_next/static paths", () => {
  assert.equal(normalizeStaticRef("static/chunks/a.js"), "/_next/static/chunks/a.js")
  assert.equal(normalizeStaticRef("/_next/static/css/a.css?v=1"), "/_next/static/css/a.css")
  assert.equal(normalizeStaticRef("\\u002F_next\\u002Fstatic\\u002Fchunks\\u002Fb.js"), "/_next/static/chunks/b.js")
  assert.equal(normalizeStaticRef("/_next/static/../../etc/passwd"), null)
  assert.equal(normalizeStaticRef("/settings.html"), null)
})

test("isRootPageFile admits page-loaded root files but never the app service worker", () => {
  assert.equal(isRootPageFile("/swe-worker-abc123.js"), true)
  assert.equal(isRootPageFile("/favicon.ico"), true)
  assert.equal(isRootPageFile("/sw.js"), false)
  assert.equal(isRootPageFile("/plugins/x/index.js"), false)
  assert.equal(isRootPageFile("/settings.html"), false)
})

test("collectors find HTML, CSS and literal script references", () => {
  const html = '<script src="/_next/static/chunks/x.js"></script><link href="/favicon.ico">'
  assert.deepEqual([...collectHtmlRefs(html)], ["/_next/static/chunks/x.js"])
  assert.deepEqual([...collectLocalLinks(html)], ["/favicon.ico"])
  // Next's cache-busting query is stripped; the app's PWA manifest is never shipped.
  const head =
    '<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/favicon.ico?757f38b1">' +
    '<link rel="apple-touch-icon" href="/apple-icon.png?4d6c1a65">'
  assert.deepEqual([...collectLocalLinks(head)], ["/favicon.ico", "/apple-icon.png"])
  assert.deepEqual(
    [...collectCssRefs("a{src:url('../media/f.woff2')} b{src:url(https://x/y.png)}", "/_next/static/css/a.css")],
    ["/_next/static/media/f.woff2"]
  )
  assert.deepEqual([...collectScriptRefs('x("static/chunks/a-1.js");y="static/chunks/"+id+".js"')], [
    "/_next/static/chunks/a-1.js",
  ])
})

test("staticClosure follows CSS and scripts to a fixed point", () => {
  const out = fakeExport()
  try {
    const refs = staticClosure(out, readFileSync(path.join(out, "status.html"), "utf8"))
    assert.deepEqual([...refs].sort(), [
      "/_next/static/chunks/lazy.js",
      "/_next/static/chunks/main.js",
      "/_next/static/chunks/page.js",
      "/_next/static/css/a.css",
      "/_next/static/media/font.woff2",
    ])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test("locateStatusHtml supports both export layouts and fails loudly without one", () => {
  const out = fakeExport()
  const empty = mkdtempSync(path.join(tmpdir(), "status-empty-"))
  try {
    assert.equal(locateStatusHtml(out), path.join(out, "status.html"))
    assert.throws(() => locateStatusHtml(empty), /no exported status page/)
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test("buildStatusSite copies only the status closure and writes a manifest", async () => {
  const out = fakeExport()
  const dest = mkdtempSync(path.join(tmpdir(), "status-dest-"))
  writeFileSync(path.join(dest, ".gitkeep"), "")
  writeFileSync(path.join(dest, "stale.js"), "old deploy")
  try {
    const manifest = await buildStatusSite({ out, dest, crawl: false })
    const paths = manifest.files.map((file) => file.path).sort()
    assert.deepEqual(paths, [
      "/_next/static/chunks/lazy.js",
      "/_next/static/chunks/main.js",
      "/_next/static/chunks/page.js",
      "/_next/static/css/a.css",
      "/_next/static/media/font.woff2",
      "/favicon.ico",
      "/status.txt",
      "/status/__next._tree.txt",
      "/status/index.html",
    ])
    assert.equal(manifest.buildId, "BUILD")
    assert.ok(existsSync(path.join(dest, ".gitkeep")))
    assert.ok(!existsSync(path.join(dest, "stale.js")))
    assert.ok(!existsSync(path.join(dest, "settings.html")))
    assert.ok(!existsSync(path.join(dest, "_next", "static", "chunks", "other-route.js")))
    assert.match(manifest.files.find((file) => file.path === "/status/index.html").sha256, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})

test("crawlLocales covers every app locale so each lazily loaded catalog chunk ships", async () => {
  // A zh-CN browser loads the zh-CN catalog chunk; crawling only the default
  // locale shipped a status site that failed to load its language pack.
  assert.deepEqual(await crawlLocales(), ["en", "zh-CN"])
})
