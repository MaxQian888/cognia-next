import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "A2UI Mini-Apps - Cognia",
  description: "Browse, create, and edit interactive A2UI mini-apps powered by your agents",
}

export default function A2UILayout({ children }: { children: React.ReactNode }) {
  return children
}
