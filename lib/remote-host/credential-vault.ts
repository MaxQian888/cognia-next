import { clearSecret, getSecret, setSecret } from "@/lib/keyring"

const NAMESPACE = "remote-host"

export interface RemoteHostCredential {
  devicePrivateKeyJwk: JsonWebKey
  signalingPrivateKeyJwk?: JsonWebKey
}

export function remoteHostCredentialRef(hostId: string): string {
  return `${NAMESPACE}:${hostId}`
}

export async function saveRemoteHostCredential(
  hostId: string,
  credential: RemoteHostCredential
): Promise<string> {
  if (!credential.devicePrivateKeyJwk) {
    throw new Error("Remote host credential requires a device private key")
  }
  await setSecret(
    { namespace: NAMESPACE, key: hostId },
    JSON.stringify({
      devicePrivateKeyJwk: credential.devicePrivateKeyJwk,
      ...(credential.signalingPrivateKeyJwk
        ? { signalingPrivateKeyJwk: credential.signalingPrivateKeyJwk }
        : {}),
    })
  )
  return remoteHostCredentialRef(hostId)
}

export async function loadRemoteHostCredential(
  hostId: string
): Promise<RemoteHostCredential | null> {
  const raw = await getSecret({ namespace: NAMESPACE, key: hostId })
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteHostCredential>
    if (!parsed.devicePrivateKeyJwk || typeof parsed.devicePrivateKeyJwk !== "object") return null
    return {
      devicePrivateKeyJwk: parsed.devicePrivateKeyJwk,
      ...(parsed.signalingPrivateKeyJwk && typeof parsed.signalingPrivateKeyJwk === "object"
        ? { signalingPrivateKeyJwk: parsed.signalingPrivateKeyJwk }
        : {}),
    }
  } catch {
    return null
  }
}

export async function clearRemoteHostCredential(hostId: string): Promise<void> {
  await clearSecret({ namespace: NAMESPACE, key: hostId })
}
