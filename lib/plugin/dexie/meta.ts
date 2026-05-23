import { getDb, type PluginDexieMeta } from "@/lib/db/schema"

export async function getPluginDexieMeta(pluginId: string): Promise<PluginDexieMeta | undefined> {
  return getDb().pluginDexieMeta.get(pluginId)
}

export async function putPluginDexiaMeta(row: PluginDexieMeta): Promise<void> {
  await getDb().pluginDexieMeta.put(row)
}

export async function deletePluginDexiaMeta(pluginId: string): Promise<void> {
  await getDb().pluginDexieMeta.delete(pluginId)
}

export async function getAllPluginDexiaMeta(): Promise<PluginDexieMeta[]> {
  return getDb().pluginDexieMeta.toArray()
}
