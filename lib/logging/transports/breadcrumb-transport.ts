import type {
  LogLevel,
  StructuredLogEntry,
  Transport,
  TransportHealthSnapshot,
} from "@/types/logging"
import { pushCrashBreadcrumb } from "@/lib/native/crash-context"
import { isTauri } from "@/lib/tauri"
import { recordDrop } from "@cognia/logging/types/transport"

/**
 * Breadcrumb transport — forwards warn+ frontend log entries to the Rust
 * crash-context breadcrumb ring (`pushCrashBreadcrumb`), giving a later panic
 * / native crash report a real "what was happening" trail. This is the first
 * real consumer of that previously-dormant bridge.
 *
 * Two guards keep the 50-slot breadcrumb ring meaningful:
 *  - level floor (warn) — info/debug noise would churn the ring out;
 *  - `origin === "tauri"` skip — native logs arrive back in the frontend via
 *    the `log://log` bridge tagged `origin: "tauri"`, so forwarding them would
 *    echo Rust logs straight back to Rust as breadcrumbs.
 * A small rate limiter caps bursts so a log storm can't flush the ring.
 */

export interface BreadcrumbTransportOptions {
  /** Minimum level to forward as a breadcrumb. Default `warn`. */
  minLevel?: LogLevel
  /** Max breadcrumbs forwarded per interval window. Default 5. */
  maxPerInterval?: number
  /** Rate-limit window in ms. Default 1000. */
  intervalMs?: number
  /** Injected clock for tests. Defaults to `Date.now`. */
  now?: () => number
}

const DEFAULT_OPTIONS: Required<Omit<BreadcrumbTransportOptions, "now">> = {
  minLevel: "warn",
  maxPerInterval: 5,
  intervalMs: 1000,
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
}

export class BreadcrumbTransport implements Transport {
  name = "breadcrumb"

  private readonly options: Required<Omit<BreadcrumbTransportOptions, "now">>
  private readonly now: () => number
  private windowStart = 0
  private windowCount = 0
  private health: TransportHealthSnapshot = {
    transport: "breadcrumb",
    status: isTauri() ? "healthy" : "offline",
    queueDepth: 0,
    retryCount: 0,
    droppedEntries: 0,
    droppedByReason: {},
    updatedAt: new Date().toISOString(),
  }

  constructor(options: BreadcrumbTransportOptions = {}) {
    const { now, ...rest } = options
    this.options = { ...DEFAULT_OPTIONS, ...rest }
    this.now = now ?? (() => Date.now())
  }

  log(entry: StructuredLogEntry): void {
    if (!isTauri()) {
      return
    }
    if (LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[this.options.minLevel]) {
      return
    }
    // Skip native-origin entries echoed back through the `log://log` bridge
    // (the bridge tags them `origin: "tauri"`).
    if (entry.origin === "tauri") {
      return
    }
    if (this.isRateLimited()) {
      // Rate limiting refuses the entry itself; nothing was queued to lose.
      this.health = {
        ...this.health,
        droppedEntries: this.health.droppedEntries + 1,
        droppedByReason: recordDrop(
          { ...(this.health.droppedByReason ?? {}) },
          "entry-rejected",
          1
        ),
        updatedAt: new Date().toISOString(),
      }
      return
    }

    void pushCrashBreadcrumb(`[${entry.module}] ${entry.message}`, entry.level)
    this.health = {
      ...this.health,
      status: "healthy",
      lastSuccessAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  getHealth(): TransportHealthSnapshot {
    return this.health
  }

  private isRateLimited(): boolean {
    const now = this.now()
    if (now - this.windowStart >= this.options.intervalMs) {
      this.windowStart = now
      this.windowCount = 1
      return false
    }
    if (this.windowCount >= this.options.maxPerInterval) {
      return true
    }
    this.windowCount += 1
    return false
  }
}

export function createBreadcrumbTransport(
  options?: BreadcrumbTransportOptions
): BreadcrumbTransport {
  return new BreadcrumbTransport(options)
}
