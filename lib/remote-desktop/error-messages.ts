/**
 * Host and viewer refusal codes → `remoteDesktop.errors.*` message keys.
 * Codes are the stable `remote_desktop_*` strings the Host returns; the key is
 * the suffix in camelCase. An unknown code falls back to a generic message
 * that still names the code, so a new Host refusal is never silent.
 */

export const REMOTE_DESKTOP_ERROR_CODES = [
  "remote_desktop_adapter_unknown",
  "remote_desktop_admin_lease_required",
  "remote_desktop_auth_failed",
  "remote_desktop_binding_access_invalid",
  "remote_desktop_binding_cannot_be_read_only",
  "remote_desktop_binding_changed",
  "remote_desktop_binding_count_invalid",
  "remote_desktop_binding_disabled",
  "remote_desktop_binding_has_no_authentication",
  "remote_desktop_binding_has_no_endpoint",
  "remote_desktop_binding_id_invalid",
  "remote_desktop_binding_not_bridged",
  "remote_desktop_binding_not_found",
  "remote_desktop_binding_not_launchable",
  "remote_desktop_bridge_unavailable",
  "remote_desktop_config_invalid",
  "remote_desktop_connect_failed",
  "remote_desktop_connect_timeout",
  "remote_desktop_connection_lost",
  "remote_desktop_console_profile_unknown",
  "remote_desktop_console_unavailable",
  "remote_desktop_console_url_has_credentials",
  "remote_desktop_console_url_insecure",
  "remote_desktop_console_url_invalid",
  "remote_desktop_control_busy",
  "remote_desktop_credential_invalid",
  "remote_desktop_credential_missing",
  "remote_desktop_credential_required",
  "remote_desktop_credential_unavailable",
  "remote_desktop_endpoint_changed",
  "remote_desktop_endpoint_forbidden",
  "remote_desktop_endpoint_invalid",
  "remote_desktop_endpoint_unconfirmed",
  "remote_desktop_forbidden",
  "remote_desktop_handshake_timeout",
  "remote_desktop_host_consent_required",
  "remote_desktop_host_outdated",
  "remote_desktop_host_unavailable",
  "remote_desktop_integration_unavailable",
  "remote_desktop_internal",
  "remote_desktop_invalid_request",
  "remote_desktop_launch_app_missing",
  "remote_desktop_launch_key_invalid",
  "remote_desktop_launch_peer_invalid",
  "remote_desktop_launch_server_invalid",
  "remote_desktop_launch_uri_invalid",
  "remote_desktop_launcher_unknown",
  "remote_desktop_lease_lost",
  "remote_desktop_page_token_invalid",
  "remote_desktop_protocol_invalid",
  "remote_desktop_protocol_unsupported",
  "remote_desktop_provider_duplicate",
  "remote_desktop_provider_id_invalid",
  "remote_desktop_provider_port_invalid",
  "remote_desktop_resolve_failed",
  "remote_desktop_resolve_timeout",
  "remote_desktop_security_unsupported",
  "remote_desktop_server_refused",
  "remote_desktop_session_attached",
  "remote_desktop_session_limit",
  "remote_desktop_session_not_found",
  "remote_desktop_storage_corrupt",
  "remote_desktop_storage_invalid",
  "remote_desktop_storage_limit",
  "remote_desktop_storage_unavailable",
  "remote_desktop_storage_version",
  "remote_desktop_target_limit",
  "remote_desktop_target_name_invalid",
  "remote_desktop_target_not_found",
  "remote_desktop_ticket_expired",
  "remote_desktop_transport_unavailable",
  "remote_desktop_unavailable",
  "remote_desktop_unknown_command",
  "remote_desktop_viewer_failed",
  "remote_desktop_viewer_invalid",
  "remote_desktop_viewer_requires_webview",
] as const

export type RemoteDesktopErrorCode = (typeof REMOTE_DESKTOP_ERROR_CODES)[number]

const KNOWN = new Set<string>(REMOTE_DESKTOP_ERROR_CODES)

export function errorKeyOf(code: RemoteDesktopErrorCode): string {
  const suffix = code.slice("remote_desktop_".length)
  return suffix.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/**
 * The message key under `remoteDesktop.errors` and its values. Host details
 * are untrusted server text: shown verbatim as a value, never as markup.
 */
export function remoteDesktopErrorMessage(
  code: string,
  detail?: string
): { key: string; values: Record<string, string> } {
  if (!KNOWN.has(code)) return { key: "unknown", values: { code } }
  return {
    key: errorKeyOf(code as RemoteDesktopErrorCode),
    values: { detail: detail ?? "", code },
  }
}
