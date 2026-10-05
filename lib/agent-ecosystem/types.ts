/**
 * The ecosystem cross-reference row. Owned by `@cognia/agent-contracts`
 * (ADR-0217) so integration packages can declare their own rows; see that
 * module for what the table stores and deliberately does not.
 */
export {
  hasLaunchableRuntime,
  isMigratable,
  type AgentEcosystemEntry,
} from "@cognia/agent-contracts/ecosystem"
