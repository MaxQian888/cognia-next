import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react"
import { useInput, type Key } from "ink"

export type TuiInputHandler = (input: string, key: Key) => boolean
type CapturedInputHandler = (input: string, key: Key) => void
type CapturedInputOptions = {
  isActive?: boolean
  shouldHandle?: (input: string, key: Key) => boolean
}

export const TUI_INPUT_PRIORITY = {
  composer: 100,
  composerPopup: 200,
  global: 300,
  modalBody: 350,
  modal: 400,
  critical: 500,
} as const

interface RouteRegistration {
  id: symbol
  sequence: number
  priority: number
  active: boolean
  handler: TuiInputHandler
}

interface InputRouterContextValue {
  register: (route: RouteRegistration) => () => void
}

const InputRouterContext = createContext<InputRouterContextValue | null>(null)

export function TuiInputProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const routes = useRef(new Map<symbol, RouteRegistration>())
  const sequence = useRef(0)
  const register = useCallback((route: RouteRegistration) => {
    const registered = { ...route, sequence: ++sequence.current }
    routes.current.set(route.id, registered)
    return () => {
      routes.current.delete(route.id)
    }
  }, [])

  useInput((input, key) => {
    const ordered = [...routes.current.values()]
      .filter((route) => route.active)
      .sort((a, b) => b.priority - a.priority || b.sequence - a.sequence)
    for (const route of ordered) {
      if (route.handler(input, key)) break
    }
  })

  const value = useMemo(() => ({ register }), [register])
  return <InputRouterContext.Provider value={value}>{children}</InputRouterContext.Provider>
}

export function useTuiInput(
  handler: TuiInputHandler,
  options: { priority: number; isActive?: boolean }
): void {
  const router = useContext(InputRouterContext)
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  }, [handler])
  const currentHandler = useCallback(
    (input: string, key: Key) => handlerRef.current(input, key),
    []
  )
  const id = useRef(Symbol("tui-input-route"))
  const active = options.isActive !== false

  // Isolated component tests intentionally omit the application provider. Keep
  // that public test seam working while production mounts exactly one active
  // Ink listener in TuiInputProvider.
  useInput((input, key) => void currentHandler(input, key), {
    isActive: router === null && active,
  })

  useEffect(() => {
    if (!router) return
    return router.register({
      id: id.current,
      sequence: 0,
      priority: options.priority,
      active,
      handler: currentHandler,
    })
  }, [router, options.priority, active, currentHandler])
}

function useCapturedInput(
  handler: CapturedInputHandler,
  priority: number,
  options: CapturedInputOptions = {}
): void {
  useTuiInput(
    (input, key) => {
      if (options.shouldHandle && !options.shouldHandle(input, key)) return false
      handler(input, key)
      return true
    },
    { priority, ...(options.isActive === undefined ? {} : { isActive: options.isActive }) }
  )
}

/** A mounted modal owns all keyboard input, including currently-unused keys. */
export function useModalInput(
  handler: CapturedInputHandler,
  options: CapturedInputOptions = {}
): void {
  useCapturedInput(handler, TUI_INPUT_PRIORITY.modal, options)
}

/** Document/body navigation yields to controls nested inside the same modal. */
export function useModalBodyInput(
  handler: CapturedInputHandler,
  options: CapturedInputOptions = {}
): void {
  useCapturedInput(handler, TUI_INPUT_PRIORITY.modalBody, options)
}

export function useComposerInput(
  handler: CapturedInputHandler,
  options: { isActive?: boolean; popupOpen?: boolean } = {}
): void {
  useCapturedInput(
    handler,
    options.popupOpen ? TUI_INPUT_PRIORITY.composerPopup : TUI_INPUT_PRIORITY.composer,
    options
  )
}

/** Global shortcuts intentionally fall through to the focused composer. */
export function useGlobalInput(
  handler: CapturedInputHandler,
  options: CapturedInputOptions = {}
): void {
  useCapturedInput(handler, TUI_INPUT_PRIORITY.global, options)
}

export function useCriticalInput(
  handler: CapturedInputHandler,
  options: CapturedInputOptions = {}
): void {
  useCapturedInput(handler, TUI_INPUT_PRIORITY.critical, options)
}
