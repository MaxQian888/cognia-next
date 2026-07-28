import test from "node:test"
import { strict as assert } from "node:assert"

import {
  raiseIosDeploymentTarget,
  setLaunchScreenBackground,
} from "./configure-ios-project.mjs"

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
