import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { restoreWebPluginAssets, restoreFromCapacitorHook } from "./restore-web-plugin-assets.mjs"

test("Capacitor hook restores route data and plugin mirrors on Android and iOS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-plugin-copy-"))
  try {
    const web = path.join(root, "out")
    await mkdir(path.join(web, "plugins/theme"), { recursive: true })
    await writeFile(path.join(web, "plugins/__next._tree.txt"), "route-data")
    await writeFile(path.join(web, "plugins/theme/icon.svg"), "icon")
    for (const [platform, target] of [
      ["android", "android/app/src/main/assets/public"],
      ["ios", "ios/App/App/public"],
    ]) {
      const native = path.join(root, target)
      await mkdir(path.join(native, "plugins/cordova-plugin"), { recursive: true })
      await writeFile(path.join(native, "plugins/cordova-plugin/index.js"), "native")
      await restoreFromCapacitorHook({
        CAPACITOR_PLATFORM_NAME: platform,
        CAPACITOR_ROOT_DIR: root,
        CAPACITOR_WEB_DIR: web,
      })
      await restoreWebPluginAssets(web, native)
      assert.equal(
        await readFile(path.join(native, "plugins/__next._tree.txt"), "utf8"),
        "route-data"
      )
      assert.equal(await readFile(path.join(native, "plugins/theme/icon.svg"), "utf8"), "icon")
      assert.equal(
        await readFile(path.join(native, "plugins/cordova-plugin/index.js"), "utf8"),
        "native"
      )
      await writeFile(path.join(native, "plugins/theme/icon.svg"), "conflict")
      await assert.rejects(restoreWebPluginAssets(web, native), /conflicts/)
    }
    await restoreWebPluginAssets(path.join(root, "empty-dev-web"), path.join(root, "dev-native"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("copy refuses symlink destinations and missing hook context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-plugin-copy-link-"))
  try {
    await mkdir(path.join(root, "out/plugins"), { recursive: true })
    await writeFile(path.join(root, "out/plugins/route.txt"), "source")
    await mkdir(path.join(root, "native"))
    await mkdir(path.join(root, "outside"))
    await symlink(path.join(root, "outside"), path.join(root, "native/plugins"), "dir")
    await assert.rejects(
      restoreWebPluginAssets(path.join(root, "out"), path.join(root, "native")),
      /symlink/
    )
    await assert.rejects(restoreFromCapacitorHook({}), /hook/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
