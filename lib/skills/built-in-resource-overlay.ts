import type { SkillResource } from "@cognia/agent-config-types"

import { loadBuiltInSkillResourcePayload } from "@/generated/built-in-skills/built-in-resource-loader.generated"
import { resolveBuiltinSkillIdentity } from "./built-in-catalog"

/** Load one generated built-in resource chunk without persisting it to Dexie. */
export async function loadBuiltInResourceOverlay(
  skillId: string,
  options: { includeCompliance?: boolean } = {}
): Promise<SkillResource[] | null> {
  const identity = resolveBuiltinSkillIdentity(skillId)
  if (!identity) return null
  const payload = await loadBuiltInSkillResourcePayload(identity.bundleId)
  return payload
    .filter((resource) => options.includeCompliance !== false || resource.role !== "compliance")
    .map((resource, index) => ({
      id: `${identity.storageId}:resource:${index}`,
      skillId: identity.storageId,
      kind: resource.kind,
      name: resource.name,
      path: resource.path,
      content: resource.content,
      encoding: "utf-8",
      size: new TextEncoder().encode(resource.content).byteLength,
      createdAt: 0,
      updatedAt: 0,
    }))
}
