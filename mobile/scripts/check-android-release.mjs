import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { verifyArtifact, verifyOfflineConfig, ARTIFACT_FILE } from "./android-artifact.mjs"

export async function checkAndroidRelease(assetsDirectory) {
  await verifyOfflineConfig(path.join(assetsDirectory, "capacitor.config.json"))
  const directory = path.join(assetsDirectory, "public")
  const artifact = JSON.parse(await readFile(path.join(directory, ARTIFACT_FILE), "utf8"))
  await verifyArtifact(directory, artifact.inputDigest)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = fileURLToPath(new URL("../android/app/src/main/assets", import.meta.url))
  checkAndroidRelease(assets).catch((error) => {
    console.error(`[mobile-release] ${error.message}`)
    process.exitCode = 1
  })
}
