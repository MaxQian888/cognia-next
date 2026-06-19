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

/**
 * Maximum serialized payload size (bytes) accepted by a single message.
 * PluginIPC enforces this via `IPCConfig.maxMessageSize`; the MessageBus
 * enforces the same ceiling on `emit` so the two channels agree (the bus
 * was previously unbounded — an asymmetry with the hardened IPC layer).
 * 1 MiB matches the IPC default.
 */
export const PLUGIN_MESSAGE_MAX_BYTES = 1024 * 1024
