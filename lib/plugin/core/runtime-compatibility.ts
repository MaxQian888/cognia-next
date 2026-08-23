import type {
  ExtensionCompatibilityDiagnostic,
  PluginManifest,
  PluginRuntimeProfile,
} from "@/types/plugin"

/** Resolve one plugin's declared availability for a concrete host profile. */
export function collectPluginRuntimeProfileDiagnostics(
  manifest: PluginManifest,
  runtimeProfile: PluginRuntimeProfile
): ExtensionCompatibilityDiagnostic[] {
  if (runtimeProfile === "tauri") return []

  const compatibilityMap = manifest.runtimeCompatibility
  let compatibility = compatibilityMap?.[runtimeProfile]
  let fallbackSurface: "browser" | "tauri" | undefined

  if (!compatibility && runtimeProfile === "mobile") {
    fallbackSurface = "browser"
    compatibility = compatibilityMap?.browser
  } else if (!compatibility && runtimeProfile === "headless") {
    const nativeOrNodeTarget =
      manifest.type !== "frontend" ||
      Boolean(manifest.engines?.node || compatibilityMap?.tauri?.entrypoint === "node")
    fallbackSurface = nativeOrNodeTarget ? "tauri" : "browser"
    compatibility = compatibilityMap?.[fallbackSurface]
  }

  const fallbackNote = fallbackSurface ? ` (inherited from ${fallbackSurface} compatibility)` : ""
  if (!compatibility) {
    return [
      {
        code: `runtime.${runtimeProfile}.unsupported`,
        severity: "error",
        message: `Plugin ${manifest.id} does not declare ${runtimeProfile} runtime compatibility.`,
        hint: `Add ${runtimeProfile} runtime compatibility metadata before enabling this plugin in ${runtimeProfile} mode.`,
      },
    ]
  }
  if (compatibility.availability === "supported") return []
  if (compatibility.availability === "degraded") {
    return [
      {
        code: `runtime.${runtimeProfile}.degraded`,
        severity: "warning",
        message:
          compatibility.reason ||
          `Plugin ${manifest.id} is only partially supported in ${runtimeProfile} runtime${fallbackNote}.`,
        hint: compatibility.entrypoint
          ? `${runtimeProfile} bundle entrypoint: ${compatibility.entrypoint}`
          : undefined,
      },
    ]
  }
  return [
    {
      code: `runtime.${runtimeProfile}.unsupported`,
      severity: "error",
      message:
        compatibility.reason ||
        `Plugin ${manifest.id} is blocked in ${runtimeProfile} runtime${fallbackNote}.`,
      hint: compatibility.entrypoint
        ? `Declared ${runtimeProfile} entrypoint: ${compatibility.entrypoint}`
        : undefined,
    },
  ]
}
