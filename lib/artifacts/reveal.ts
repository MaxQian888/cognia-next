import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { Artifact } from "@/types"

export function revealArtifactInWorkspace(id: string): Artifact | null {
  const store = useArtifactStore.getState()
  const artifact = store.artifacts[id]

  if (!artifact) {
    return null
  }

  store.setActiveArtifact(id)
  store.openPanel("artifact")
  return artifact
}
