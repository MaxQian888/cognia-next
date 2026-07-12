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
 *   - CFBundleURLTypes (cognia://)  — the OAuth / share-target / pair-QR
 *                                     deep-link scheme. Previously a
 *                                     hand-edit per IOS_BOOTSTRAP.md; a
 *                                     regenerated iOS project that missed
 *                                     it silently dropped every deep link.
 *   - NS*UsageDescription strings   — camera (QR pair / chat attach),
 *                                     photo library (attach / save),
 *                                     microphone (voice messages),
 *                                     Face ID (app unlock + sensitive ops),
 *                                     location (workflow triggers), and
 *                                     local network (companion pairing).
 *                                     iOS KILLS the app at permission-request
 *                                     time when the matching key is missing,
 *                                     so these are correctness, not polish.
 *
 * Idempotent: re-running on a patched plist is a no-op per key.
 *
 * The companion bilingual strings live in
 *   mobile/ios/App/App/en.lproj/InfoPlist.strings
 *   mobile/ios/App/App/zh-Hans.lproj/InfoPlist.strings
 * and are also created/extended here if missing.
 *
 * Run via `pnpm -F mobile patch:ios` (also chained by `add:ios`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname.replace(/^\//, ""))
const PLIST_PATH = resolve(REPO_ROOT, "mobile/ios/App/App/Info.plist")

const SERVICE_TYPE = "_cognia._tcp"
const URL_SCHEME = "cognia"

/**
 * Usage-description keys required by the Capacitor plugins the app ships
 * (see mobile/IOS_BOOTSTRAP.md). `en` lands in Info.plist as the default;
 * both languages land in the lproj InfoPlist.strings files.
 */
export const USAGE_DESCRIPTIONS = [
  {
    key: "NSCameraUsageDescription",
    en: "cognia needs camera access to scan pairing QR codes, attach photos to chats, and capture documents for your digital twin.",
    zh: "cognia 在你扫码配对、附加照片到聊天、给数字孪生录入文档时需要相机访问",
  },
  {
    key: "NSPhotoLibraryUsageDescription",
    en: "cognia needs photo library access to attach images from your library to chats and back up albums.",
    zh: "cognia 在你从相册附加图片到聊天或备份图集时需要相册访问",
  },
  {
    key: "NSPhotoLibraryAddUsageDescription",
    en: "cognia needs write access to save images from chats to your photo library.",
    zh: "cognia 在你保存聊天里的图片到相册时需要写入权限",
  },
  {
    key: "NSMicrophoneUsageDescription",
    en: "cognia needs microphone access to record voice messages.",
    zh: "cognia 在你录制语音消息时需要麦克风访问",
  },
  {
    key: "NSFaceIDUsageDescription",
    en: "cognia uses Face ID to unlock the app and confirm sensitive actions (delete pairing, export backups).",
    zh: "cognia 用 Face ID 解锁应用与确认敏感操作（删除配对、导出备份）",
  },
  {
    key: "NSLocationWhenInUseUsageDescription",
    en: "cognia needs your current position for workflow location triggers (foreground only).",
    zh: "cognia 在工作流的位置触发器里需要当前位置（仅在前台使用）",
  },
  {
    key: "NSLocalNetworkUsageDescription",
    en: "cognia needs to discover your paired desktop on this local network.",
    zh: "cognia 需要在本地网络中查找已配对的桌面端。",
  },
]

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function insertBeforeClosingDict(xml, insert) {
  return xml.replace(/<\/dict>\s*<\/plist>\s*$/u, `${insert}</dict>\n</plist>\n`)
}

export function patchPlist(xml) {
  let out = xml
  let changed = false

  if (!/NSBonjourServices/.test(out)) {
    const insert = `\t<key>NSBonjourServices</key>\n\t<array>\n\t\t<string>${SERVICE_TYPE}</string>\n\t</array>\n`
    out = insertBeforeClosingDict(out, insert)
    changed = true
  } else if (!out.includes(SERVICE_TYPE)) {
    // Existing array, missing our service. Inject.
    out = out.replace(
      /(<key>NSBonjourServices<\/key>\s*<array>)([\s\S]*?)(<\/array>)/,
      (_match, head, body, tail) => `${head}\n\t\t<string>${SERVICE_TYPE}</string>${body}${tail}`
    )
    changed = true
  }

  for (const { key, en } of USAGE_DESCRIPTIONS) {
    if (new RegExp(key).test(out)) continue
    const insert = `\t<key>${key}</key>\n\t<string>${escapeXml(en)}</string>\n`
    out = insertBeforeClosingDict(out, insert)
    changed = true
  }

  // `cognia://` deep-link scheme (OAuth callbacks, share-target, pair QR).
  // Only inserted when no CFBundleURLTypes block exists at all — merging
  // into a hand-maintained block is riskier than leaving it alone.
  if (!/CFBundleURLTypes/.test(out)) {
    const insert =
      `\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n` +
      `\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>app.cognia.deeplink</string>\n` +
      `\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n` +
      `\t\t\t\t<string>${URL_SCHEME}</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n`
    out = insertBeforeClosingDict(out, insert)
    changed = true
  }

  // Push notifications need the `remote-notification` background mode so
  // silent / content-available APNs payloads can wake the app to sync. The
  // `aps-environment` entitlement + Push Notifications capability still have to
  // be added via an App.entitlements file in Xcode (see IOS_BOOTSTRAP.md) —
  // only the Info.plist half is automatable here, and without it
  // `PushNotifications.register()` background delivery never fires.
  if (!/UIBackgroundModes/.test(out)) {
    const insert = `\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>remote-notification</string>\n\t</array>\n`
    out = insertBeforeClosingDict(out, insert)
    changed = true
  } else if (!/remote-notification/.test(out)) {
    out = out.replace(
      /(<key>UIBackgroundModes<\/key>\s*<array>)([\s\S]*?)(<\/array>)/,
      (_match, head, body, tail) => `${head}\n\t\t<string>remote-notification</string>${body}${tail}`
    )
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
  for (const { key, en, zh } of USAGE_DESCRIPTIONS) {
    if (writeLproj(enPath, key, en)) console.log(`[patch-ios-info-plist] Wrote ${key} → ${enPath}`)
    if (writeLproj(zhPath, key, zh)) console.log(`[patch-ios-info-plist] Wrote ${key} → ${zhPath}`)
  }
}

// Allow `node --test` files to import { patchPlist, USAGE_DESCRIPTIONS }
// without executing the patcher (same guard as inject-server-fingerprint.mjs).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`
) {
  main()
}
