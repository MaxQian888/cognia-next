type BedrockAuthMode = "api-key" | "iam" | "default-chain"
/**
 * Persisted Amazon Bedrock connection settings. Fields are optional while the
 * settings form is being edited; call {@link validateBedrockConnectionSettings}
 * before constructing a provider client.
 */
interface BedrockConnectionSettings {
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
interface ResolvedBedrockCredentialMetadata {
  authMode: BedrockAuthMode
  region: string
  source: "api-key" | "explicit-iam" | "default-chain"
  profile?: string
  roleArn?: string
}
type BedrockValidationField = "region" | "apiKey" | "accessKeyId" | "secretAccessKey"
interface BedrockValidationIssue {
  field: BedrockValidationField
  code: "required"
  message: string
}
interface BedrockValidationResult {
  valid: boolean
  issues: BedrockValidationIssue[]
}
declare function validateBedrockConnectionSettings(
  settings: BedrockConnectionSettings
): BedrockValidationResult
declare function getResolvedBedrockCredentialMetadata(
  settings: BedrockConnectionSettings
): ResolvedBedrockCredentialMetadata | undefined

export {
  type BedrockAuthMode,
  type BedrockConnectionSettings,
  type BedrockValidationField,
  type BedrockValidationIssue,
  type BedrockValidationResult,
  type ResolvedBedrockCredentialMetadata,
  getResolvedBedrockCredentialMetadata,
  validateBedrockConnectionSettings,
}
