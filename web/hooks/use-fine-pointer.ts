"use client"

import { useSyncExternalStore } from "react"

const QUERY = "(pointer: fine) and (hover: hover)"

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined
  }

  const media = window.matchMedia(QUERY)
  media.addEventListener("change", onStoreChange)
  return () => media.removeEventListener("change", onStoreChange)
}

function getSnapshot() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(QUERY).matches
  )
}

const getServerSnapshot = () => false

/** Reports whether a precise hover-capable pointer is currently available. */
export function useFinePointer() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
