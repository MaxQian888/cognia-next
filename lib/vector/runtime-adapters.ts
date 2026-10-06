import {
  setVectorRuntimeAdapters,
  type VectorRuntimeAdapters,
} from "@cognia/vector/runtime-adapters"
import { isTauri } from "@/lib/platform/detect"

/** Install synchronously before consumers run; expensive host modules stay lazy. */
export function installVectorRuntimeAdapters(): void {
  setVectorRuntimeAdapters(buildVectorRuntimeAdapters())
}

export function buildVectorRuntimeAdapters(): VectorRuntimeAdapters {
  return {
    isTauri,
    async createBedrockEmbeddingModel({ modelId, bedrock }) {
      const { createBedrockSidecarEmbeddingModel } = await import("@/lib/claude/feature-call")
      return createBedrockSidecarEmbeddingModel({
        modelId,
        providerId: "bedrock",
        credentials: {
          protocol: "bedrock",
          bedrockAuthMode: "default-chain",
          region: bedrock.region,
          baseURL: bedrock.baseURL,
          profile: bedrock.profile,
          roleArn: bedrock.roleArn,
          roleSessionName: bedrock.roleSessionName,
        },
      })
    },
    async dispatchDocumentsIndexed(collection, count) {
      const { getPluginEventHooks } = await import("@/lib/plugin/messaging/hooks-system")
      getPluginEventHooks().dispatchDocumentsIndexed(collection, count)
    },
    async dispatchVectorSearch(collection, query, count) {
      const { getPluginEventHooks } = await import("@/lib/plugin/messaging/hooks-system")
      getPluginEventHooks().dispatchVectorSearch(collection, query, count)
    },
  }
}
