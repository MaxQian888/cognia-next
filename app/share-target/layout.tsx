import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Share to Cognia",
  description: "Pick a chat session to receive shared content",
}

export default function ShareTargetLayout({ children }: { children: React.ReactNode }) {
  return children
}
