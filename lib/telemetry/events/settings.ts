export const BEHAVIOR_TELEMETRY_STORAGE_KEY = "cognia-behavior-telemetry-enabled"

export function isBehaviorTelemetryEnabled(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem(BEHAVIOR_TELEMETRY_STORAGE_KEY) === "true"
  )
}

export function setBehaviorTelemetryEnabled(enabled: boolean): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(BEHAVIOR_TELEMETRY_STORAGE_KEY, String(enabled))
  }
}
