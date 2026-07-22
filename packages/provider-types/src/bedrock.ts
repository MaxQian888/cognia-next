export type BedrockAuthMode = "api-key" | "iam" | "default-chain"

/**
 * Persisted Amazon Bedrock connection settings. Fields are optional while the
 * settings form is being edited; call {@link validateBedrockConnectionSettings}
 * before constructing a provider client.
 */
export interface BedrockConnectionSettings {
  authMode: BedrockAuthMode
  region?: string
  baseURL?: string
  apiKey?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  profile?: string
  roleArn?: string
  roleSessionName?: string
}

/** Secret-free metadata suitable for telemetry and diagnostics. */
export interface ResolvedBedrockCredentialMetadata {
  authMode: BedrockAuthMode
  region: string
  source: "api-key" | "explicit-iam" | "default-chain"
  profile?: string
  roleArn?: string
}

export type BedrockValidationField = "region" | "apiKey" | "accessKeyId" | "secretAccessKey"

export interface BedrockValidationIssue {
  field: BedrockValidationField
  code: "required"
  message: string
}

export interface BedrockValidationResult {
  valid: boolean
  issues: BedrockValidationIssue[]
}

function isBlank(value: string | undefined): boolean {
  return !value || value.trim().length === 0
}

export function validateBedrockConnectionSettings(
  settings: BedrockConnectionSettings
): BedrockValidationResult {
  const issues: BedrockValidationIssue[] = []
  if (isBlank(settings.region)) {
    issues.push({ field: "region", code: "required", message: "AWS region is required." })
  }
  if (settings.authMode === "api-key" && isBlank(settings.apiKey)) {
    issues.push({ field: "apiKey", code: "required", message: "Bedrock API key is required." })
  }
  if (settings.authMode === "iam") {
    if (isBlank(settings.accessKeyId)) {
      issues.push({
        field: "accessKeyId",
        code: "required",
        message: "Access key ID is required.",
      })
    }
    if (isBlank(settings.secretAccessKey)) {
      issues.push({
        field: "secretAccessKey",
        code: "required",
        message: "Secret access key is required.",
      })
    }
  }
  return { valid: issues.length === 0, issues }
}

export function getResolvedBedrockCredentialMetadata(
  settings: BedrockConnectionSettings
): ResolvedBedrockCredentialMetadata | undefined {
  const validation = validateBedrockConnectionSettings(settings)
  if (!validation.valid || !settings.region) return undefined
  return {
    authMode: settings.authMode,
    region: settings.region.trim(),
    source:
      settings.authMode === "api-key"
        ? "api-key"
        : settings.authMode === "iam"
          ? "explicit-iam"
          : "default-chain",
    ...(settings.profile?.trim() ? { profile: settings.profile.trim() } : {}),
    ...(settings.roleArn?.trim() ? { roleArn: settings.roleArn.trim() } : {}),
  }
}
