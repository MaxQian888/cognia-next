/**
 * Plugin Security - Security exports
 */

export {
  PermissionGuard,
  getPermissionGuard,
  resetPermissionGuard,
  PermissionError,
  createGuardedAPI,
  PERMISSION_GROUPS,
  PERMISSION_DESCRIPTIONS,
  DANGEROUS_PERMISSIONS,
  type PermissionRequest,
  type PermissionGrant,
  type PermissionAuditEntry,
} from "./permission-guard"

export {
  PluginSignatureVerifier,
  getPluginSignatureVerifier,
  resetPluginSignatureVerifier,
  type PluginSignature,
  type SignatureVerificationResult,
  type SignerInfo,
  type TrustLevel,
  type TrustedPublisher,
} from "./signature"
