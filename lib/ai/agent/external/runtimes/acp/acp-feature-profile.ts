import type { ClientCapabilities } from "@agentclientprotocol/sdk"

export const ACP_V1_SCHEMA_VERSION = "1.21.0" as const

export type AcpRole = "client" | "agent"
export type AcpHostKind = "desktop" | "cli" | "headless" | "server"
export type AcpPreviewFeature =
  | "compaction"
  | "providers"
  | "dynamicMcp"
  | "nes"
  | "identifiedPlans"
  | "previewToolNames"
  | "sessionFork"

export type AcpPreviewEnablement = Partial<Record<AcpPreviewFeature, boolean | null>>

export interface AcpHostCapabilities {
  kind: AcpHostKind
  fs: { read: boolean; write: boolean }
  terminal: boolean
  terminalAuth: boolean
  elicitation: {
    form: boolean
    url: boolean
    durableInteraction: boolean
  }
  preview: Record<AcpPreviewFeature, boolean>
}

export interface AcpFeatureState {
  enabled: boolean
  supported: boolean
  advertised: boolean
}

export interface AcpFeatureProfile {
  role: AcpRole
  host: AcpHostKind
  protocol: { wireVersion: 1; schemaVersion: typeof ACP_V1_SCHEMA_VERSION }
  advertisedVersions: readonly [1]
  clientCapabilities: ClientCapabilities
  preview: Record<AcpPreviewFeature, AcpFeatureState>
}

export interface ResolveAcpFeatureProfileOptions {
  role: AcpRole
  host: AcpHostCapabilities
  /** `false`/`null` is an explicit kill switch; `true` retains the legacy opt-in spelling. */
  elicitationEnabled?: boolean | null
  preview?: AcpPreviewEnablement | null
}

const PREVIEW_FEATURES: readonly AcpPreviewFeature[] = [
  "compaction",
  "providers",
  "dynamicMcp",
  "nes",
  "identifiedPlans",
  "previewToolNames",
  "sessionFork",
]

export function resolveAcpFeatureProfile({
  role,
  host,
  elicitationEnabled,
  preview,
}: ResolveAcpFeatureProfileOptions): AcpFeatureProfile {
  const elicitationAllowed =
    elicitationEnabled !== false &&
    elicitationEnabled !== null &&
    (host.kind !== "headless" || host.elicitation.durableInteraction)

  const previewState = Object.fromEntries(
    PREVIEW_FEATURES.map((feature) => {
      const enabled = preview?.[feature] === true
      const supported = host.preview[feature]
      return [feature, { enabled, supported, advertised: enabled && supported }]
    })
  ) as Record<AcpPreviewFeature, AcpFeatureState>

  const clientCapabilities: ClientCapabilities = {
    session: {
      configOptions: { boolean: {} },
      ...(previewState.compaction.advertised ? { compaction: {} } : {}),
    },
    ...(host.fs.read || host.fs.write
      ? { fs: { readTextFile: host.fs.read, writeTextFile: host.fs.write } }
      : {}),
    ...(host.terminal ? { terminal: true } : {}),
    ...(host.terminal && host.terminalAuth ? { auth: { terminal: true } } : {}),
    ...(elicitationAllowed && (host.elicitation.form || host.elicitation.url)
      ? {
          elicitation: {
            ...(host.elicitation.form ? { form: {} } : {}),
            ...(host.elicitation.url ? { url: {} } : {}),
          },
        }
      : {}),
    ...(previewState.identifiedPlans.advertised ? { plan: {} } : {}),
    ...(previewState.nes.advertised ? { nes: {}, positionEncodings: ["utf-16"] } : {}),
  }

  return {
    role,
    host: host.kind,
    protocol: { wireVersion: 1, schemaVersion: ACP_V1_SCHEMA_VERSION },
    advertisedVersions: [1],
    clientCapabilities,
    preview: previewState,
  }
}
