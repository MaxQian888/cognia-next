import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Goals - Cognia",
  description: "Manage persistent self-driving goals (ADR-0019)",
}

export default function GoalsLayout({ children }: { children: React.ReactNode }) {
  return children
}
