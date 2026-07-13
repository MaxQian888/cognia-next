/**
 * Logger Transports — the framework-agnostic implementations (ADR-0068 E4).
 * The app-coupled transports (native, breadcrumb, agent-trace, otlp-http,
 * langfuse) live in `lib/logging/transports/`; the app barrel there
 * re-exports both sets so `@/lib/logging/transports` keeps its full surface.
 */

export {
  ConsoleTransport,
  createConsoleTransport,
  type ConsoleTransportOptions,
} from "./console-transport"
export {
  IndexedDBTransport,
  createIndexedDBTransport,
  type IndexedDBTransportOptions,
} from "./indexeddb-transport"
export {
  RemoteTransport,
  createRemoteTransport,
  sentryTransform,
  logglyTransform,
  type RemoteTransportOptions,
} from "./remote-transport"
export {
  OtelTransport,
  createOtelTransport,
  getOtelContext,
  withOtelSpan,
  type OtelTransportOptions,
} from "./otel-transport"
export {
  IndexedDBRemoteRetryQueueStore,
  createRemoteRetryQueueStore,
  type RemoteRetryQueueStore,
  type RemoteRetryQueueBatch,
  type RemoteRetryQueueStats,
  type RemoteRetryQueueLimits,
  type RemoteRetryQueueEnqueueResult,
} from "./remote-retry-queue-store"
