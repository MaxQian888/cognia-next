// Re-export shim: canonical source moved to @cognia/provider-types (Stage 1).
export {
  DEPLOYMENT_KEY_SEPARATOR,
  DEPLOYMENT_MODEL_WILDCARD,
  deploymentKeyOf,
  deploymentKeyOfEntry,
  parseDeploymentKey,
  providerIdOfDeploymentKey,
  wildcardDeploymentKey,
} from "@cognia/provider-types/deployment"
export type { DeploymentKey } from "@cognia/provider-types/deployment"
