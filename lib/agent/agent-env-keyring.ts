import { clearSecret, getSecret, setSecret } from "@/lib/keyring"

export const AGENT_ENV_KEYRING_NAMESPACE = "agent-env"

function keyringRef(secretRef: string) {
  return { namespace: AGENT_ENV_KEYRING_NAMESPACE, key: secretRef }
}

/** Create the persistable reference; the secret value is deliberately absent. */
export function createAgentEnvSecretRef(
  agentId: string,
  variableName: string,
  nonce: string = crypto.randomUUID()
): string {
  return `${agentId}:${variableName}:${nonce}`
}

export function loadAgentEnvSecret(secretRef: string): Promise<string | null> {
  return getSecret(keyringRef(secretRef))
}

export async function saveAgentEnvSecret(secretRef: string, value: string): Promise<void> {
  if (!value) throw new Error("Agent environment secret must not be empty")
  await setSecret(keyringRef(secretRef), value)
}

export function clearAgentEnvSecret(secretRef: string): Promise<void> {
  return clearSecret(keyringRef(secretRef))
}
