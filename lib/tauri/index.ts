"use client"

// Barrel export for every Tauri plugin wrapper. Business code should import
// from "@/lib/tauri" (which re-exports this) or directly from these named
// modules — never from the underlying `@tauri-apps/plugin-*` packages.

export * from "./autostart"
export * from "./cli"
export * from "./clipboard"
export * from "./deep-link"
export * from "./events"
export * from "./notification"
export * from "./opener"
export * from "./os"
export * from "./store"
