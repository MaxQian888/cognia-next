import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

const source = readFileSync(new URL("../android/app/src/main/java/com/cognia/mobile/CogniaDeviceServicesPlugin.java", import.meta.url), "utf8")

test("orientation capability follows Android API, target SDK and 600dp boundary", () => {
  // Execute the actual native predicate with synthetic device values. Native
  // compilation checks Java API wiring; this guards the platform-policy boundary.
  const predicate = source.match(/boolean restricted = ([\s\S]*?);/)?.[1]
  assert.ok(predicate)
  for (const [api, target, width, restricted] of [
    [36, 36, 600, true], [36, 36, 599, false], [35, 36, 800, false],
    [36, 35, 800, false], [37, 37, 840, true],
  ]) {
    const actual = runInNewContext(predicate, {
      Build: { VERSION: { SDK_INT: api } },
      getContext: () => ({
        getApplicationInfo: () => ({ targetSdkVersion: target }),
        getResources: () => ({ getConfiguration: () => ({ smallestScreenWidthDp: width }) }),
      }),
    })
    assert.equal(actual, restricted, `${api}/${target}/${width}`)
  }
  assert.match(source, /@PluginMethod\s+public void getOrientationLockSupport/)
  assert.match(source, /result\.put\("supported", !restricted\)/)
})
