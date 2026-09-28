import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { sidecarVersionDefines } from "./sidecar-version-info.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url))
test("bundled version metadata works without adjacent package files", async () => {
  const define = sidecarVersionDefines(root)
  const result = await build({
    entryPoints: [new URL("../../../sidecar/src/host/version-info.ts", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", target: "node26", write: false,
    define,
  })
  const versionModule = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
  assert.deepEqual(versionModule.readVersionInfo(), JSON.parse(define.__COGNIA_SIDECAR_VERSION_INFO__))
  assert.equal(typeof versionModule.readVersionInfo().sdkVersion, "string")
  assert.equal(typeof versionModule.readVersionInfo().sidecarVersion, "string")
})
