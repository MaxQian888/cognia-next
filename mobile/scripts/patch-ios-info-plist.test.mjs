import test from "node:test"
import { strict as assert } from "node:assert"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"

import {
  patchPlist,
  resolveRepoRoot,
  USAGE_DESCRIPTIONS,
} from "./patch-ios-info-plist.mjs"

const EMPTY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Cognia</string>
</dict>
</plist>
`

test("resolves the repository root as an absolute macOS path", () => {
  const root = resolveRepoRoot(new URL("./patch-ios-info-plist.mjs", import.meta.url).href)
  const expected = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

  assert.equal(isAbsolute(root), true)
  assert.equal(root, expected)
})

test("adds NSBonjourServices and every usage-description key to a fresh plist", () => {
  const { out, changed } = patchPlist(EMPTY_PLIST)
  assert.equal(changed, true)
  assert.match(out, /NSBonjourServices/)
  assert.match(out, /_cognia\._tcp/)
  for (const { key } of USAGE_DESCRIPTIONS) {
    assert.match(out, new RegExp(key), `${key} missing`)
  }
  // Structure stays a valid plist: single closing dict/plist at the end.
  assert.match(out, /<\/dict>\n<\/plist>\n$/)
})

test("is idempotent — patching a patched plist changes nothing", () => {
  const first = patchPlist(EMPTY_PLIST)
  const second = patchPlist(first.out)
  assert.equal(second.changed, false)
  assert.equal(second.out, first.out)
})

test("exposes Documents exports in Files and declares the linked location API", () => {
  const { out } = patchPlist(EMPTY_PLIST)
  assert.match(out, /<key>UIFileSharingEnabled<\/key>\s*<true\/>/)
  assert.match(out, /<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<true\/>/)
  assert.match(out, /<key>NSLocationAlwaysAndWhenInUseUsageDescription<\/key>/)
  assert.doesNotMatch(out, /<string>location<\/string>/)
})

test("the shipped target bundles its filesystem privacy reasons and localized usage descriptions", () => {
  const project = readFileSync(new URL("../ios/App/App.xcodeproj/project.pbxproj", import.meta.url), "utf8")
  const privacy = readFileSync(new URL("../ios/App/App/PrivacyInfo.xcprivacy", import.meta.url), "utf8")
  assert.match(privacy, /NSPrivacyAccessedAPICategoryFileTimestamp/)
  assert.match(privacy, /C617\.1/)
  const resources = project.slice(project.indexOf("/* Begin PBXResourcesBuildPhase"), project.indexOf("/* End PBXResourcesBuildPhase"))
  assert.match(resources, /PrivacyInfo\.xcprivacy in Resources/)
  assert.match(resources, /InfoPlist\.strings in Resources/)
  for (const language of ["en", "zh-Hans"]) {
    assert.ok(project.includes(`${language}.lproj/InfoPlist.strings`))
    const strings = readFileSync(new URL(`../ios/App/App/${language}.lproj/InfoPlist.strings`, import.meta.url), "utf8")
    assert.match(strings, /"NSLocationAlwaysAndWhenInUseUsageDescription" = ".+";/)
  }
})

test("injects the service into an existing NSBonjourServices array", () => {
  const withArray = EMPTY_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>_other._tcp</string>\n\t</array>\n</dict>\n</plist>"
  )
  const { out, changed } = patchPlist(withArray)
  assert.equal(changed, true)
  assert.match(out, /_cognia\._tcp/)
  assert.match(out, /_other\._tcp/)
})

test("adds the cognia:// CFBundleURLTypes block to a fresh plist", () => {
  const { out, changed } = patchPlist(EMPTY_PLIST)
  assert.equal(changed, true)
  assert.match(out, /CFBundleURLTypes/)
  assert.match(out, /<string>cognia<\/string>/)
  assert.match(out, /<string>cn\.cognia\.app<\/string>/)
})

test("adds the OIDC callback scheme to our own deep-link entry, once", () => {
  const ownEntry = EMPTY_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>app.cognia.deeplink</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>cognia</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n</dict>\n</plist>"
  )
  const first = patchPlist(ownEntry)
  assert.equal(first.changed, true)
  assert.match(
    first.out,
    /\t\t\t\t<string>cognia<\/string>\n\t\t\t\t<string>cn\.cognia\.app<\/string>\n\t\t\t<\/array>/
  )
  assert.equal(first.out.match(/cn\.cognia\.app/g).length, 1)
  assert.equal(patchPlist(first.out).out.match(/cn\.cognia\.app/g).length, 1)
})

test("leaves an existing CFBundleURLTypes block untouched", () => {
  const withUrlTypes = EMPTY_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>custom</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n</dict>\n</plist>"
  )
  const { out } = patchPlist(withUrlTypes)
  // No second block is inserted, the hand-maintained scheme stays.
  assert.equal(out.match(/CFBundleURLTypes/g).length, 1)
  assert.match(out, /<string>custom<\/string>/)
  // A block that is not ours gains nothing either.
  assert.doesNotMatch(out, /cn\.cognia\.app/)
})

test("adds UIBackgroundModes remote-notification to a fresh plist (iOS push)", () => {
  const { out, changed } = patchPlist(EMPTY_PLIST)
  assert.equal(changed, true)
  assert.match(out, /UIBackgroundModes/)
  assert.match(out, /<string>remote-notification<\/string>/)
  assert.match(out, /<string>fetch<\/string>/)
})

test("injects required modes into an existing UIBackgroundModes array", () => {
  const withModes = EMPTY_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>audio</string>\n\t</array>\n</dict>\n</plist>"
  )
  const { out, changed } = patchPlist(withModes)
  assert.equal(changed, true)
  assert.match(out, /<string>remote-notification<\/string>/)
  assert.match(out, /<string>fetch<\/string>/)
  assert.match(out, /<string>audio<\/string>/)
  // The existing single array is reused, not duplicated.
  assert.equal(out.match(/UIBackgroundModes/g).length, 1)
})

test("adds a local-network-only App Transport Security exception", () => {
  const { out, changed } = patchPlist(EMPTY_PLIST)

  assert.equal(changed, true)
  assert.match(out, /NSAppTransportSecurity/)
  assert.match(out, /NSAllowsLocalNetworking/)
  assert.doesNotMatch(out, /NSAllowsArbitraryLoads/)
})

test("preserves existing App Transport Security settings", () => {
  const withAts = EMPTY_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoadsInWebContent</key>\n\t\t<false/>\n\t</dict>\n</dict>\n</plist>"
  )
  const { out, changed } = patchPlist(withAts)

  assert.equal(changed, true)
  assert.match(out, /NSAllowsLocalNetworking/)
  assert.match(out, /NSAllowsArbitraryLoadsInWebContent/)
  assert.equal(out.match(/NSAppTransportSecurity/g).length, 1)
})

test("escapes XML-sensitive characters in usage strings", () => {
  // Guard: no raw & / < in inserted strings (would corrupt the plist).
  const { out } = patchPlist(EMPTY_PLIST)
  const inserted = out.slice(EMPTY_PLIST.indexOf("<key>CFBundleDisplayName"))
  assert.doesNotMatch(inserted, /<string>[^<]*&(?!amp;|lt;|gt;)/)
})
