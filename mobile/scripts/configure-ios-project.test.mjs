import test from "node:test"
import { strict as assert } from "node:assert"

import {
  buildEntitlementsPlist,
  ensureApsEnvironment,
  linkEntitlementsInPbxproj,
  raiseIosDeploymentTarget,
  setLaunchScreenBackground,
} from "./configure-ios-project.mjs"

/** Minimal pbxproj: one project-level config + the two App-target configs. */
const PBXPROJ = [
  "/* Begin PBXFileReference section */",
  '\t\t504EC3131FED79650016851F /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>"; };',
  "/* End PBXFileReference section */",
  "",
  "/* Begin PBXGroup section */",
  "\t\t504EC3061FED79650016851F /* App */ = {",
  "\t\t\tisa = PBXGroup;",
  "\t\t\tchildren = (",
  "\t\t\t\t504EC3131FED79650016851F /* Info.plist */,",
  "\t\t\t);",
  "\t\t};",
  "/* End PBXGroup section */",
  "",
  "/* Begin XCBuildConfiguration section */",
  "\t\t504EC3141FED79650016851F /* Debug */ = {",
  "\t\t\tisa = XCBuildConfiguration;",
  "\t\t\tbuildSettings = {",
  "\t\t\t\tALWAYS_SEARCH_USER_PATHS = NO;",
  "\t\t\t\tSDKROOT = iphoneos;",
  "\t\t\t};",
  "\t\t\tname = Debug;",
  "\t\t};",
  "\t\t504EC3171FED79650016851F /* Debug */ = {",
  "\t\t\tisa = XCBuildConfiguration;",
  "\t\t\tbuildSettings = {",
  "\t\t\t\tCODE_SIGN_STYLE = Automatic;",
  "\t\t\t\tINFOPLIST_FILE = App/Info.plist;",
  "\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.cognia.mobile;",
  "\t\t\t};",
  "\t\t\tname = Debug;",
  "\t\t};",
  "\t\t504EC3181FED79650016851F /* Release */ = {",
  "\t\t\tisa = XCBuildConfiguration;",
  "\t\t\tbuildSettings = {",
  "\t\t\t\tCODE_SIGN_STYLE = Automatic;",
  "\t\t\t\tINFOPLIST_FILE = App/Info.plist;",
  "\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.cognia.mobile;",
  "\t\t\t};",
  "\t\t\tname = Release;",
  "\t\t};",
  "/* End XCBuildConfiguration section */",
].join("\n")

test("raises CocoaPods and Xcode deployment targets below iOS 16", () => {
  const source = [
    "platform :ios, '15.0'",
    "IPHONEOS_DEPLOYMENT_TARGET = 15.0;",
    "IPHONEOS_DEPLOYMENT_TARGET = 15.5;",
  ].join("\n")

  const { out, replacements } = raiseIosDeploymentTarget(source)

  assert.equal(replacements, 3)
  assert.equal(out.match(/16\.0/gu)?.length, 3)
  assert.doesNotMatch(out, /15\.[05]/u)
})

test("keeps deployment targets that already meet the minimum", () => {
  const source = [
    "platform :ios, '16.0'",
    "IPHONEOS_DEPLOYMENT_TARGET = 17.0;",
  ].join("\n")

  const { out, replacements } = raiseIosDeploymentTarget(source)

  assert.equal(replacements, 0)
  assert.equal(out, source)
})

test("does not modify unrelated version numbers", () => {
  const source = [
    "MARKETING_VERSION = 1.0;",
    "CURRENT_PROJECT_VERSION = 1;",
  ].join("\n")

  const { out, replacements } = raiseIosDeploymentTarget(source)

  assert.equal(replacements, 0)
  assert.equal(out, source)
})

test("sets an idempotent Cognia launch-screen background", () => {
  const source =
    '<color key="backgroundColor" systemColor="systemBackgroundColor"/>'
  const first = setLaunchScreenBackground(source)
  const second = setLaunchScreenBackground(first.out)

  assert.equal(first.changed, true)
  assert.match(first.out, /red="0\.0039215686274509803"/u)
  assert.match(first.out, /blue="0\.11764705882352941"/u)
  assert.equal(second.changed, false)
  assert.equal(second.out, first.out)
})

test("the generated entitlements plist declares aps-environment development", () => {
  const plist = buildEntitlementsPlist()

  assert.match(plist, /<key>aps-environment<\/key>/u)
  assert.match(plist, /<string>development<\/string>/u)
  // Xcode derives the real value from the provisioning profile at signing time,
  // so `production` must never be hard-coded here.
  assert.doesNotMatch(plist, /production/u)
})

test("ensureApsEnvironment adds the key while preserving other capabilities", () => {
  const existing = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>keychain-access-groups</key>",
    "\t<array>",
    "\t\t<string>$(AppIdentifierPrefix)com.cognia.mobile</string>",
    "\t</array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n")

  const first = ensureApsEnvironment(existing)
  const second = ensureApsEnvironment(first.out)

  assert.equal(first.changed, true)
  assert.match(first.out, /<key>aps-environment<\/key>/u)
  assert.match(first.out, /keychain-access-groups/u)
  // Idempotent: a second sync must not append a duplicate key.
  assert.equal(second.changed, false)
  assert.equal(first.out.match(/aps-environment/gu).length, 1)
})

test("ensureApsEnvironment throws on a plist it cannot insert into", () => {
  // Returning `changed: false` here made the caller print "aps-environment
  // already declared" and exit 0 — a build that silently cannot register with
  // APNs, which is the failure this script exists to prevent.
  assert.throws(
    () => ensureApsEnvironment('<?xml version="1.0"?>\n<plist version="1.0">\n'),
    /malformed/iu
  )
})

test("links the entitlements file into both App-target build configurations", () => {
  const { out, settingsAdded, referenceAdded } = linkEntitlementsInPbxproj(PBXPROJ)

  assert.equal(settingsAdded, 2)
  assert.equal(referenceAdded, true)
  assert.equal(out.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/gu).length, 2)
  // Sorted immediately before CODE_SIGN_STYLE, the way Xcode writes it.
  assert.match(
    out,
    /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;\n\t+CODE_SIGN_STYLE = Automatic;/u
  )
  // Registered in the navigator next to Info.plist.
  assert.match(out, /lastKnownFileType = text\.plist\.entitlements/u)
  assert.match(out, /Info\.plist \*\/,\n\t+\S+ \/\* App\.entitlements \*\/,/u)
})

test("does not put CODE_SIGN_ENTITLEMENTS on project-level configurations", () => {
  const { out } = linkEntitlementsInPbxproj(PBXPROJ)
  const projectBlock = out.slice(
    out.indexOf("ALWAYS_SEARCH_USER_PATHS"),
    out.indexOf("504EC3171FED79650016851F")
  )

  assert.doesNotMatch(projectBlock, /CODE_SIGN_ENTITLEMENTS/u)
})

test("linkEntitlementsInPbxproj is idempotent", () => {
  const first = linkEntitlementsInPbxproj(PBXPROJ)
  const second = linkEntitlementsInPbxproj(first.out)

  assert.equal(second.changed, false)
  assert.equal(second.settingsAdded, 0)
  assert.equal(second.referenceAdded, false)
  assert.equal(second.out, first.out)
})
