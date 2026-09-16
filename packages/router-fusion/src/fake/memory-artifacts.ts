/** In-memory ArtifactStore for tests and the offline mock path; content-addressed by sha256. */

import { sha256Hex } from "../util/sha256"
import type { ArtifactStore, StoredArtifact } from "../workflows/ports"

export class MemoryArtifactStore implements ArtifactStore {
  readonly items = new Map<
    string,
    { content: string; artifact: StoredArtifact; namespace: string }
  >()
  private seq = 0

  async put(content: string, mediaType: string, namespace: string): Promise<StoredArtifact> {
    const n = ++this.seq
    const artifact: StoredArtifact = {
      artifactId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
      contentSha256: sha256Hex(content),
      sizeBytes: new TextEncoder().encode(content).length,
      mediaType,
    }
    this.items.set(artifact.artifactId, { content, artifact, namespace })
    return artifact
  }

  async get(artifactId: string) {
    const item = this.items.get(artifactId)
    return item ? { content: item.content, artifact: item.artifact } : null
  }
}
