/**
 * Tab Leader Election
 * Ensures only one browser tab executes scheduled tasks at a time.
 * Uses BroadcastChannel for communication and Web Locks API for leader election.
 * Falls back to periodic heartbeat via localStorage for browsers without Web Locks.
 */

import { loggers } from "@cognia/logging"

const log = loggers.scheduler

const CHANNEL_NAME = "cognia-scheduler-leader"
const LOCK_NAME = "cognia-scheduler-leader-lock"
const HEARTBEAT_KEY = "cognia-scheduler-leader-heartbeat"
const HEARTBEAT_INTERVAL = 2000 // 2 seconds
const HEARTBEAT_TIMEOUT = 5000 // 5 seconds — leader considered dead if no heartbeat

type LeaderChangeCallback = (isLeader: boolean) => void

interface TabLeaderState {
  isLeader: boolean
  tabId: string
  listeners: Set<LeaderChangeCallback>
  heartbeatTimer: ReturnType<typeof setInterval> | null
  channel: BroadcastChannel | null
  lockAbortController: AbortController | null
  storageHandler: ((event: StorageEvent) => void) | null
}

const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const state: TabLeaderState = {
  isLeader: false,
  tabId,
  listeners: new Set(),
  heartbeatTimer: null,
  channel: null,
  lockAbortController: null,
  storageHandler: null,
}

function setLeader(value: boolean): void {
  if (state.isLeader === value) return
  state.isLeader = value
  log.info(`[TabLock] Tab ${tabId} is now ${value ? "LEADER" : "FOLLOWER"}`)
  state.listeners.forEach((cb) => {
    try {
      cb(value)
    } catch {
      /* ignore listener errors */
    }
  })
}

/**
 * Start leader election using Web Locks API (preferred) or heartbeat fallback.
 */
export async function startLeaderElection(): Promise<void> {
  if (typeof window === "undefined") {
    // SSR — always leader
    setLeader(true)
    return
  }

  // Set up BroadcastChannel for cross-tab communication
  try {
    state.channel = new BroadcastChannel(CHANNEL_NAME)
    state.channel.onmessage = (event) => {
      if (event.data?.type === "leader-claimed" && event.data?.tabId !== tabId) {
        setLeader(false)
      }
    }
  } catch {
    log.warn("[TabLock] BroadcastChannel not available")
  }

  // Try Web Locks API first (Chrome 69+, Firefox 96+, Safari 15.4+)
  if ("locks" in navigator) {
    startWebLocksElection()
  } else {
    startHeartbeatElection()
  }
}

/**
 * Web Locks API — acquires an exclusive lock. Only one tab holds it at a time.
 * When the tab closes or crashes, the lock is automatically released.
 */
function startWebLocksElection(): void {
  state.lockAbortController = new AbortController()

  navigator.locks
    .request(LOCK_NAME, { signal: state.lockAbortController.signal }, async () => {
      // We acquired the lock — we are the leader
      setLeader(true)
      broadcastLeaderClaimed()

      // Hold the lock until the tab closes or stopLeaderElection is called
      return new Promise<void>((resolve) => {
        // This promise resolves only when we want to release the lock
        const checkAbort = () => {
          if (state.lockAbortController?.signal.aborted) {
            resolve()
          }
        }
        state.lockAbortController?.signal.addEventListener("abort", checkAbort)
      })
    })
    .catch((err) => {
      // AbortError is expected when we stop the election
      if (err instanceof DOMException && err.name === "AbortError") return
      log.warn("[TabLock] Web Locks election error, falling back to heartbeat", {
        error: String(err),
      })
      startHeartbeatElection()
    })
}

/**
 * Heartbeat-based fallback using localStorage.
 * Each leader writes a timestamp periodically. If the timestamp is stale, another tab can claim leadership.
 */
function startHeartbeatElection(): void {
  const tryClaimLeadership = () => {
    try {
      const raw = localStorage.getItem(HEARTBEAT_KEY)
      if (raw) {
        const data = JSON.parse(raw) as { tabId: string; timestamp: number }
        const age = Date.now() - data.timestamp

        if (data.tabId === tabId) {
          // We are already the leader — refresh heartbeat
          writeHeartbeat()
          return
        }

        if (age < HEARTBEAT_TIMEOUT) {
          // Another tab is alive — stay follower
          setLeader(false)
          return
        }
      }

      // No leader or leader is dead — claim it
      writeHeartbeat()
      setLeader(true)
      broadcastLeaderClaimed()
    } catch {
      // localStorage access error — assume leader for this tab
      setLeader(true)
    }
  }

  // Check immediately
  tryClaimLeadership()

  // Then periodically
  state.heartbeatTimer = setInterval(tryClaimLeadership, HEARTBEAT_INTERVAL)

  // Listen for storage events from other tabs
  state.storageHandler = (event: StorageEvent) => {
    if (event.key === HEARTBEAT_KEY && event.newValue) {
      try {
        const data = JSON.parse(event.newValue) as { tabId: string; timestamp: number }
        if (data.tabId !== tabId) {
          setLeader(false)
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }
  window.addEventListener("storage", state.storageHandler)
}

function writeHeartbeat(): void {
  try {
    localStorage.setItem(HEARTBEAT_KEY, JSON.stringify({ tabId, timestamp: Date.now() }))
  } catch {
    /* quota exceeded — ignore */
  }
}

function broadcastLeaderClaimed(): void {
  try {
    state.channel?.postMessage({ type: "leader-claimed", tabId })
  } catch {
    /* channel closed — ignore */
  }
}

/**
 * Stop leader election and release leadership.
 */
export function stopLeaderElection(): void {
  setLeader(false)

  // Abort Web Locks
  state.lockAbortController?.abort()
  state.lockAbortController = null

  // Stop heartbeat
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = null
  }

  // Clean up localStorage
  try {
    const raw = localStorage.getItem(HEARTBEAT_KEY)
    if (raw) {
      const data = JSON.parse(raw) as { tabId: string }
      if (data.tabId === tabId) {
        localStorage.removeItem(HEARTBEAT_KEY)
      }
    }
  } catch {
    /* ignore */
  }

  // Remove storage event listener
  if (state.storageHandler) {
    window.removeEventListener("storage", state.storageHandler)
    state.storageHandler = null
  }

  // Close channel
  try {
    state.channel?.close()
  } catch {
    /* ignore */
  }
  state.channel = null
}

/**
 * Register a callback for leader changes.
 */
export function onLeaderChange(callback: LeaderChangeCallback): () => void {
  state.listeners.add(callback)
  // Immediately notify current state
  callback(state.isLeader)
  return () => state.listeners.delete(callback)
}

/**
 * Check if this tab is currently the leader.
 */
export function isLeaderTab(): boolean {
  return state.isLeader
}

/**
 * Get the current tab ID.
 */
export function getTabId(): string {
  return tabId
}
