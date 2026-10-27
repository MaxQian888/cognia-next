/**
 * External-agent wire, session and configuration contracts.
 *
 * Owned by `@cognia/agent-contracts` (ADR-0217) so integration packages, the
 * plugin SDK and every host share one definition. This path stays as the
 * compatibility entry for app importers.
 */
export * from "@cognia/agent-contracts/external-agent"
// Keep the runtime value explicit when this shim is also a bundle entry.
export { normalizeCogniaModelBinding } from "@cognia/agent-contracts/external-agent"
