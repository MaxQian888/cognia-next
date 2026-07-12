import test from "node:test"
import { strict as assert } from "node:assert"

import { patchPlist, USAGE_DESCRIPTIONS } from "./patch-ios-info-plist.mjs"

const EMPTY_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Cognia</string>
</dict>
</plist>
`

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
})

test("adds UIBackgroundModes remote-notification to a fresh plist (iOS push)", () => {
  const { out, changed } = patchPlist(EMPTY_PLIST)
  assert.equal(changed, true)
  assert.match(out, /UIBackgroundModes/)
  assert.match(out, /<string>remote-notification<\/string>/)
})

test("injects remote-notification into an existing UIBackgroundModes array", () => {
  const withModes = EMPTY_PLIST.replace(
    "</dict>\n</plist>",
    "\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>fetch</string>\n\t</array>\n</dict>\n</plist>"
  )
  const { out, changed } = patchPlist(withModes)
  assert.equal(changed, true)
  assert.match(out, /<string>remote-notification<\/string>/)
  assert.match(out, /<string>fetch<\/string>/)
  // The existing single array is reused, not duplicated.
  assert.equal(out.match(/UIBackgroundModes/g).length, 1)
})

test("escapes XML-sensitive characters in usage strings", () => {
  // Guard: no raw & / < in inserted strings (would corrupt the plist).
  const { out } = patchPlist(EMPTY_PLIST)
  const inserted = out.slice(EMPTY_PLIST.indexOf("<key>CFBundleDisplayName"))
  assert.doesNotMatch(inserted, /<string>[^<]*&(?!amp;|lt;|gt;)/)
})
