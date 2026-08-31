import { vectorCloudInvoke, type VectorCredentials } from "@cognia/vector/invoke"
import type { TwinRuntimeSettings, VectorBackend } from "@/types/twin"

export function getTwinVectorConfigId(backend: Exclude<VectorBackend, "native">): string {
  return `twin-runtime-${backend}`
}

function credentialsFor(settings: TwinRuntimeSettings): VectorCredentials | undefined {
  const storage = settings.storage
  switch (storage.vectorBackend) {
    case "qdrant":
      return storage.qdrant?.url
        ? {
            provider: "qdrant",
            url: storage.qdrant.url,
            api_key: storage.qdrant.apiKey,
            collection_name: undefined,
          }
        : undefined
    case "pinecone":
      return storage.pinecone?.apiKey && storage.pinecone.indexName
        ? {
            provider: "pinecone",
            api_key: storage.pinecone.apiKey,
            index_name: storage.pinecone.indexName,
            namespace: storage.pinecone.namespace,
          }
        : undefined
    case "weaviate":
      return storage.weaviate?.url
        ? {
            provider: "weaviate",
            url: storage.weaviate.url,
            api_key: storage.weaviate.apiKey,
          }
        : undefined
    case "milvus":
      return storage.milvus?.address
        ? {
            provider: "milvus",
            address: storage.milvus.address,
            token: storage.milvus.token,
            username: undefined,
            password: undefined,
            ssl: storage.milvus.ssl ?? false,
            collection_name: undefined,
          }
        : undefined
    case "chroma":
      return storage.chroma?.mode === "server" && storage.chroma.serverUrl
        ? {
            provider: "chroma",
            url: storage.chroma.serverUrl,
            auth_token: undefined,
          }
        : undefined
    case "native":
      return undefined
  }
}

export async function persistTwinVectorCredentials(
  settings: TwinRuntimeSettings
): Promise<string | undefined> {
  if (settings.storage.vectorBackend === "native") return undefined
  const credentials = credentialsFor(settings)
  if (!credentials) return undefined
  const configId = getTwinVectorConfigId(settings.storage.vectorBackend)
  await vectorCloudInvoke.saveCredentials(configId, credentials)
  return configId
}
