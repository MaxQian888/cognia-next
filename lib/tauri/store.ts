"use client"

import { LazyStore } from "@tauri-apps/plugin-store"
import { isTauri } from "@/lib/tauri"

/**
 * Single shared store file for app-level preferences that don't fit in
 * IndexedDB (e.g. last workspace path, autostart pref, tray-on-close flag).
 * Lives next to the app's other data dirs — Tauri picks a per-platform
 * location automatically.
 */
const STORE_FILE = "cognia.store.json"

let cached: LazyStore | null = null

function getStore(): LazyStore | null {
  if (!isTauri()) return null
  if (!cached) cached = new LazyStore(STORE_FILE, { autoSave: true, defaults: {} })
  return cached
}

/** Read a value. Returns null when outside Tauri or when the key is missing. */
export async function getPref<T = unknown>(key: string): Promise<T | null> {
  const store = getStore()
  if (!store) return null
  try {
    const value = await store.get<T>(key)
    return value ?? null
  } catch (err) {
    console.warn(`store.get(${key}) failed`, err)
    return null
  }
}

/** Write a value. No-op outside Tauri. */
export async function setPref<T>(key: string, value: T): Promise<void> {
  const store = getStore()
  if (!store) return
  try {
    await store.set(key, value)
  } catch (err) {
    console.warn(`store.set(${key}) failed`, err)
  }
}

export async function deletePref(key: string): Promise<void> {
  const store = getStore()
  if (!store) return
  try {
    await store.delete(key)
  } catch (err) {
    console.warn(`store.delete(${key}) failed`, err)
  }
}

/** Force a flush to disk — `autoSave: true` already does this on each set. */
export async function flushPrefs(): Promise<void> {
  const store = getStore()
  if (!store) return
  try {
    await store.save()
  } catch (err) {
    console.warn("store.save failed", err)
  }
}
