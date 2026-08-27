const MACOS_ARM64_FULL_BASELINE_BYTES = 128_023_568
const MACOS_ARM64_SLIM_LIMIT_BYTES = 38 * 1024 * 1024

export function assertCliArtifactSizes(report) {
  const fullBytes = report.variants.full?.archiveBytes
  const slimBytes = report.variants.slim?.archiveBytes
  if (!Number.isFinite(fullBytes) || !Number.isFinite(slimBytes)) return report

  const reductionRatio = 1 - slimBytes / fullBytes
  report.comparison = { slimReductionRatio: reductionRatio }
  if (reductionRatio < 0.65) {
    throw new Error(
      `slim archive is only ${(reductionRatio * 100).toFixed(1)}% smaller than full; expected at least 65%`
    )
  }
  if (report.target === "darwin-arm64" && slimBytes > MACOS_ARM64_SLIM_LIMIT_BYTES) {
    throw new Error("macOS arm64 slim archive exceeds the 38 MiB limit")
  }
  if (
    report.target === "darwin-arm64" &&
    fullBytes > Math.floor(MACOS_ARM64_FULL_BASELINE_BYTES * 1.01)
  ) {
    throw new Error("macOS arm64 full archive regressed by more than 1%")
  }
  return report
}
