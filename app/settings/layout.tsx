import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Settings — Cognia",
  description: "Configure defaults, your API key, prompt presets, MCP servers and more.",
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children
}
