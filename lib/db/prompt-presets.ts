import type { SystemPromptPreset } from "@/lib/claude/types"
import { getDb } from "./schema"

function newId() {
  return "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export async function listPresets(): Promise<SystemPromptPreset[]> {
  return getDb().promptPresets.orderBy("updatedAt").reverse().toArray()
}

export async function getPreset(id: string): Promise<SystemPromptPreset | undefined> {
  return getDb().promptPresets.get(id)
}

export async function createPreset(
  partial: Pick<SystemPromptPreset, "name" | "content">
): Promise<SystemPromptPreset> {
  const now = Date.now()
  const preset: SystemPromptPreset = {
    id: newId(),
    name: partial.name.trim() || "Untitled preset",
    content: partial.content,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().promptPresets.put(preset)
  return preset
}

export async function updatePreset(
  id: string,
  patch: Partial<Pick<SystemPromptPreset, "name" | "content">>
): Promise<void> {
  await getDb().promptPresets.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deletePreset(id: string): Promise<void> {
  await getDb().promptPresets.delete(id)
}
