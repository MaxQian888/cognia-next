#!/usr/bin/env node
/**
 * Post-`cap add ios` Info.plist patcher (Wave 4 / ADR-0026).
 *
 * Adds the keys our native plugins need but that `cap add ios` does not
 * insert automatically:
 *
 *   - NSBonjourServices             — required since iOS 14 for any
 *                                     Bonjour browse; without this entry
 *                                     `_cognia._tcp` discovery returns
 *                                     zero results without an error.
 *   - NSLocalNetworkUsageDescription — the user-visible string in the
 *                                     "Allow Local Network" system prompt.
 *
 * Idempotent: re-running on a patched plist is a no-op.
 *
 * The companion bilingual strings live in
 *   mobile/ios/App/App/en.lproj/InfoPlist.strings
 *   mobile/ios/App/App/zh-Hans.lproj/InfoPlist.strings
 * and are also created here if missing.
 *
 * Run via `pnpm -F mobile cap:patch-ios` (added to mobile/package.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname.replace(/^\//, ""))
const PLIST_PATH = resolve(REPO_ROOT, "mobile/ios/App/App/Info.plist")

const SERVICE_TYPE = "_cognia._tcp"
const PERMISSION_STRING_EN = "cognia needs to discover your paired desktop on this local network."
const PERMISSION_STRING_ZH = "cognia 需要在本地网络中查找已配对的桌面端。"

function patchPlist(xml) {
  let out = xml
  let changed = false

  if (!/NSBonjourServices/.test(out)) {
    const insert = `\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>${SERVICE_TYPE}</string>\n\t</array>\n`
    out = out.replace(/<\/dict>\s*<\/plist>\s*$/u, `${insert}</dict>\n</plist>\n`)
    changed = true
  } else if (!out.includes(SERVICE_TYPE)) {
    // Existing array, missing our service. Inject.
    out = out.replace(
      /(<key>NSBonjourServices<\/key>\s*<array>)([\s\S]*?)(<\/array>)/,
      (_match, head, body, tail) => `${head}\n\t\t<string>${SERVICE_TYPE}</string>${body}${tail}`
    )
    changed = true
  }

  if (!/NSLocalNetworkUsageDescription/.test(out)) {
    const insert = `\t<key>NSLocalNetworkUsageDescription</key>\n\t<string>${PERMISSION_STRING_EN}</string>\n`
    out = out.replace(/<\/dict>\s*<\/plist>\s*$/u, `${insert}</dict>\n</plist>\n`)
    changed = true
  }

  return { out, changed }
}

function writeLproj(path, key, value) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8")
    if (current.includes(`"${key}"`)) return false
    writeFileSync(path, `${current}\n"${key}" = "${value}";\n`, "utf8")
    return true
  }
  writeFileSync(path, `"${key}" = "${value}";\n`, "utf8")
  return true
}

function main() {
  if (!existsSync(PLIST_PATH)) {
    console.error(
      `[patch-ios-info-plist] Info.plist not found at ${PLIST_PATH}. ` +
        `Run \`pnpm -F mobile cap add ios\` first.`
    )
    process.exit(1)
  }
  const xml = readFileSync(PLIST_PATH, "utf8")
  const { out, changed } = patchPlist(xml)
  if (changed) {
    writeFileSync(PLIST_PATH, out, "utf8")
    console.log(`[patch-ios-info-plist] Patched ${PLIST_PATH}`)
  } else {
    console.log(`[patch-ios-info-plist] ${PLIST_PATH} already patched`)
  }

  const enPath = resolve(REPO_ROOT, "mobile/ios/App/App/en.lproj/InfoPlist.strings")
  const zhPath = resolve(REPO_ROOT, "mobile/ios/App/App/zh-Hans.lproj/InfoPlist.strings")
  const enWritten = writeLproj(enPath, "NSLocalNetworkUsageDescription", PERMISSION_STRING_EN)
  const zhWritten = writeLproj(zhPath, "NSLocalNetworkUsageDescription", PERMISSION_STRING_ZH)
  if (enWritten) console.log(`[patch-ios-info-plist] Wrote ${enPath}`)
  if (zhWritten) console.log(`[patch-ios-info-plist] Wrote ${zhPath}`)
}

main()
