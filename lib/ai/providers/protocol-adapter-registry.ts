// Re-export shim: canonical source moved to @cognia/provider-core (Stage 2).
export {
  __resetProtocolAdaptersForTesting,
  getCodeAdapterExecutor,
  getProtocolAdapter,
  listProtocolAdapters,
  registerCodeAdapterExecutor,
  registerProtocolAdapter,
  unregisterCodeAdapterExecutor,
  unregisterCodeAdapterExecutorsByPlugin,
  unregisterProtocolAdapter,
  unregisterProtocolAdaptersByPlugin,
} from "@cognia/provider-core/providers/protocol-adapter-registry"
