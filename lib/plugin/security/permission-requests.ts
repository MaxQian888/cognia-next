/**
 * Plugin Permission Requests
 *
 * Centralized queue for permission requests that require user confirmation.
 */

import { nanoid } from "nanoid"

export type PluginPermissionRequestKind = "manifest" | "api"

export interface PluginPermissionRequest {
  id: string
  pluginId: string
  permission: string
  reason?: string
  kind: PluginPermissionRequestKind
  timestamp: number
}

export interface PermissionRequestState {
  current: PluginPermissionRequest | null
  queue: PluginPermissionRequest[]
}

type PermissionRequestListener = (state: PermissionRequestState) => void

type PermissionRequestResolver = (granted: boolean) => void

const listeners = new Set<PermissionRequestListener>()
const resolvers = new Map<string, PermissionRequestResolver>()

let state: PermissionRequestState = {
  current: null,
  queue: [],
}

function notifyListeners() {
  const snapshot: PermissionRequestState = {
    current: state.current,
    queue: [...state.queue],
  }

  listeners.forEach((listener) => listener(snapshot))
}

function enqueue(request: PluginPermissionRequest) {
  if (!state.current) {
    state = { ...state, current: request }
  } else {
    state = { ...state, queue: [...state.queue, request] }
  }

  notifyListeners()
}

function dequeueNext() {
  if (state.queue.length === 0) {
    state = { ...state, current: null }
    notifyListeners()
    return
  }

  const [next, ...rest] = state.queue
  state = { current: next, queue: rest }
  notifyListeners()
}

export function requestPluginPermission(
  input: Omit<PluginPermissionRequest, "id" | "timestamp">
): Promise<boolean> {
  const request: PluginPermissionRequest = {
    ...input,
    id: nanoid(),
    timestamp: Date.now(),
  }

  return new Promise<boolean>((resolve) => {
    resolvers.set(request.id, resolve)
    enqueue(request)
  })
}

export function resolvePluginPermission(requestId: string, granted: boolean): void {
  const resolver = resolvers.get(requestId)
  if (resolver) {
    resolver(granted)
    resolvers.delete(requestId)
  }

  if (state.current?.id === requestId) {
    dequeueNext()
    return
  }

  state = {
    ...state,
    queue: state.queue.filter((request) => request.id !== requestId),
  }
  notifyListeners()
}

export function clearPermissionRequests(): void {
  resolvers.clear()
  state = { current: null, queue: [] }
  notifyListeners()
}

export function subscribePermissionRequests(listener: PermissionRequestListener): () => void {
  listeners.add(listener)
  listener({ current: state.current, queue: [...state.queue] })

  return () => {
    listeners.delete(listener)
  }
}
