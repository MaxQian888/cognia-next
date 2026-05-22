/**
 * Shared messaging constants. Lifted out of `ipc.ts` / `message-bus.ts`
 * so the two layers stop disagreeing on capacity (previously 100 vs
 * 500 with no documented reason) and so callers / tests reference one
 * source of truth.
 */

/**
 * Maximum entries kept in any per-instance message history (PluginIPC
 * `messageHistory`, MessageBus `eventHistory`). Old entries are
 * trimmed once this is exceeded. Instance config can override per-test
 * or per-tenant, but the default is uniform.
 */
export const PLUGIN_MESSAGE_HISTORY_MAX = 500
