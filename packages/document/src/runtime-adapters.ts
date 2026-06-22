export interface DocumentLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void
}

export interface DocumentTransport {
  call<T = unknown>(command: string, args?: unknown): Promise<T>
}

export interface DocumentRuntimeAdapters {
  isTauri?: () => boolean
  transport?: DocumentTransport
  logger?: Partial<DocumentLogger>
}

function defaultIsTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

const noopLogger: DocumentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const unwiredTransport: DocumentTransport = {
  async call(): Promise<never> {
    throw new Error("Document native transport is not wired")
  },
}

let adapters: Required<Pick<DocumentRuntimeAdapters, "isTauri" | "transport">> &
  Pick<DocumentRuntimeAdapters, "logger"> = {
  isTauri: defaultIsTauri,
  transport: unwiredTransport,
  logger: {},
}

export function setDocumentRuntimeAdapters(next: DocumentRuntimeAdapters): void {
  adapters = {
    isTauri: next.isTauri ?? adapters.isTauri,
    transport: next.transport ?? adapters.transport,
    logger: {
      ...adapters.logger,
      ...next.logger,
    },
  }
}

export function resetDocumentRuntimeAdaptersForTesting(): void {
  adapters = {
    isTauri: defaultIsTauri,
    transport: unwiredTransport,
    logger: {},
  }
}

export function isTauri(): boolean {
  return adapters.isTauri()
}

export const documentTransport: DocumentTransport = {
  call<T = unknown>(command: string, args?: unknown): Promise<T> {
    return adapters.transport.call<T>(command, args)
  },
}

export function getDocumentLogger(): DocumentLogger {
  return {
    debug(message, data) {
      ;(adapters.logger?.debug ?? noopLogger.debug)(message, data)
    },
    info(message, data) {
      ;(adapters.logger?.info ?? noopLogger.info)(message, data)
    },
    warn(message, data) {
      ;(adapters.logger?.warn ?? noopLogger.warn)(message, data)
    },
    error(message, error, data) {
      ;(adapters.logger?.error ?? noopLogger.error)(message, error, data)
    },
  }
}
