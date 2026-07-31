import { parsePortableManifest, type EvalPortableManifest } from "@cognia/eval-core"
import {
  createEvalDataKey,
  decryptEvalArtifact,
  encryptEvalArtifact,
  unwrapEvalDataKey,
  wrapEvalDataKey,
  type EvalEncryptedEnvelope,
  type EvalWrappedDataKey,
} from "./artifact-crypto"

export interface EvalReplayArtifact {
  id: string
  kind: "sample" | "score" | "trajectory" | "review" | "asset"
  payload: unknown
}

export interface EvalReplayBundle {
  schema: "cognia-eval-bundle/v1"
  wrappedKey: EvalWrappedDataKey
  payload: EvalEncryptedEnvelope
}

interface EvalReplayPayload {
  manifest: EvalPortableManifest
  artifacts: EvalReplayArtifact[]
}

const SECRET_KEY = /(api[-_]?key|credential|secret|password|authorization)/i

function assertNoCredentialReferences(value: unknown, path = "bundle"): void {
  if (!value || typeof value !== "object") return
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key))
      throw new Error(`Replay bundle contains a secret reference at ${path}.${key}`)
    assertNoCredentialReferences(nested, `${path}.${key}`)
  }
}

export async function createEvalReplayBundle(
  manifest: EvalPortableManifest,
  artifacts: EvalReplayArtifact[],
  password: string
): Promise<EvalReplayBundle> {
  const validatedManifest = parsePortableManifest(manifest)
  assertNoCredentialReferences(artifacts)
  const dataKey = createEvalDataKey()
  return {
    schema: "cognia-eval-bundle/v1",
    wrappedKey: await wrapEvalDataKey(dataKey, password),
    payload: await encryptEvalArtifact(dataKey, { manifest: validatedManifest, artifacts }),
  }
}

export async function openEvalReplayBundle(
  bundle: EvalReplayBundle,
  password: string
): Promise<EvalReplayPayload> {
  if (bundle.schema !== "cognia-eval-bundle/v1") throw new Error("Unsupported replay bundle")
  const dataKey = await unwrapEvalDataKey(bundle.wrappedKey, password)
  const payload = await decryptEvalArtifact<EvalReplayPayload>(dataKey, bundle.payload)
  return { manifest: parsePortableManifest(payload.manifest), artifacts: payload.artifacts }
}
