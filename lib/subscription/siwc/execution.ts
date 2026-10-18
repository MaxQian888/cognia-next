import { sha256Hex } from "@/lib/share/hash"
import { useAccountStore } from "@/stores/account/account-store"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type { SiwcConnectionSummary } from "@/types/subscription/siwc"
import { getDb } from "@/lib/db"
import { listSiwcConnections, listSiwcModels } from "./transport"
import { encodeSiwcReference } from "./native-fetch"

/** All references are metadata, never credentials; no active/default pointer is written. */
async function verifiedSelection(connection: SiwcConnectionSummary, modelId: string) {
  const localAccountId = useAccountStore.getState().unlockedAccountId
  if (!localAccountId || !modelId.trim())
    throw new Error("SIWC selection requires an unlocked account and model")
  const db = getDb()
  let unchanged = true
  const close = useAccountStore.subscribe((state) => {
    if (state.unlockedAccountId !== localAccountId) unchanged = false
  })
  const assertCurrent = () => {
    if (
      !unchanged ||
      useAccountStore.getState().unlockedAccountId !== localAccountId ||
      getDb() !== db
    ) {
      throw new Error("Local account changed during SIWC configuration")
    }
  }
  try {
    const current = (await listSiwcConnections()).find((entry) => entry.id === connection.id)
    assertCurrent()
    if (!current || current.status !== "connected" || !current.planPermission)
      throw new Error("SIWC plan permission is required")
    const models = await listSiwcModels(current.id)
    assertCurrent()
    if (!models.some((model) => model.slug === modelId && model.visibility === "list"))
      throw new Error("SIWC model is unavailable")
    return { localAccountId, current, assertCurrent, close, db }
  } catch (cause) {
    close()
    throw cause
  }
}

export async function configureSiwcChatConnection(
  connection: SiwcConnectionSummary,
  modelId: string
): Promise<void> {
  const scope = await verifiedSelection(connection, modelId)
  try {
    scope.assertCurrent()
    const baseURL = encodeSiwcReference({
      localAccountId: scope.localAccountId,
      connectionId: scope.current.id,
    })
    const settings = useSettingsStore.getState()
    if (
      settings.settings?.customProviders?.some(
        (provider) =>
          provider.apiProtocol === "chatgpt-siwc" &&
          provider.baseURL === baseURL &&
          provider.customModels?.includes(modelId)
      )
    )
      return
    // Stable IDs let the existing serialized settings queue converge concurrent
    // setup requests without a second lock or any default/account mutation.
    const id = `custom-siwc-${await sha256Hex(
      JSON.stringify([scope.localAccountId, scope.current.id, modelId])
    )}`
    scope.assertCurrent()
    await settings.addCustomProvider(
      {
        id,
        customName: `${scope.current.label || scope.current.email || "ChatGPT"} (${scope.current.id})`,
        baseURL,
        apiKey: "",
        apiProtocol: "chatgpt-siwc",
        apiFlavor: "responses",
        customModels: [modelId],
        defaultModel: modelId,
        enabled: true,
      },
      { db: scope.db, assertActive: scope.assertCurrent }
    )
    scope.assertCurrent()
  } finally {
    scope.close()
  }
}

export async function configureSiwcAppServerConnection(
  connection: SiwcConnectionSummary,
  modelId: string
): Promise<void> {
  const scope = await verifiedSelection(connection, modelId)
  try {
    scope.assertCurrent()
    const store = useExternalAgentStore.getState()
    if (
      Object.values(store.agents).some((agent) => {
        const binding = agent.metadata?.siwc as Record<string, unknown> | undefined
        return (
          agent.protocol === "codex-siwc-app-server" &&
          binding?.localAccountId === scope.localAccountId &&
          binding?.connectionId === scope.current.id &&
          agent.metadata?.selectedModel === modelId
        )
      })
    )
      return
    store.addAgent({
      name: `ChatGPT (${scope.current.id})`,
      protocol: "codex-siwc-app-server",
      transport: "stdio",
      process: { command: "codex", args: ["app-server"] },
      enabled: false,
      defaultPermissionMode: "default",
      metadata: {
        siwc: { localAccountId: scope.localAccountId, connectionId: scope.current.id },
        selectedModel: modelId,
      },
    })
  } finally {
    scope.close()
  }
}
