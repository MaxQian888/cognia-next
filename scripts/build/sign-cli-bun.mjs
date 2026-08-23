import { spawnSync } from "node:child_process"

export function signCliArtifacts({
  targetName,
  executable,
  nativeHelpers,
  entitlements,
  identity,
  spawnSyncImpl = spawnSync,
}) {
  if (targetName !== "darwin-arm64") return false

  const signingMode = identity ? "developer-id" : "ad-hoc"
  const signer = identity || "-"
  const timestampArgs = identity ? ["--timestamp"] : []

  const runCodesign = (args) => {
    const result = spawnSyncImpl("codesign", args, { encoding: "utf8" })
    if (result.status !== 0) {
      throw new Error(
        `codesign failed (${result.status ?? result.signal ?? "unknown"})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
      )
    }
  }

  for (const helper of nativeHelpers) {
    runCodesign([
      "--force",
      "--options",
      "runtime",
      ...timestampArgs,
      "--sign",
      signer,
      helper,
    ])
  }
  runCodesign([
    "--deep",
    "--force",
    "--options",
    "runtime",
    ...timestampArgs,
    "--entitlements",
    entitlements,
    "--sign",
    signer,
    executable,
  ])
  runCodesign(["--verify", "--verbose=3", executable])
  return signingMode
}
