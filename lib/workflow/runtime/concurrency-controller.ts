import type { ConcurrencyController } from "@cognia/plugin-contract/lib/workflow/runtime/concurrency-controller"
export type { ConcurrencyController } from "@cognia/plugin-contract/lib/workflow/runtime/concurrency-controller"

export function createConcurrencyController(initial: number): ConcurrencyController {
  if (!Number.isInteger(initial)) {
    throw new Error(`createConcurrencyController: initial must be an integer, got ${initial}`)
  }
  if (initial < 0) {
    throw new Error(`createConcurrencyController: initial must be non-negative, got ${initial}`)
  }
  let current = initial
  const listeners = new Set<(n: number) => void>()
  return {
    get: () => current,
    reduceTo: (n: number) => {
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`reduceTo: n must be a non-negative integer, got ${n}`)
      }
      if (n >= current) return
      current = n
      for (const fn of listeners) {
        try {
          fn(current)
        } catch (err) {
          console.warn("ConcurrencyController listener threw:", err)
        }
      }
    },
    subscribe: (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}
