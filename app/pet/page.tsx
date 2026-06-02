"use client"

import { PetConsole } from "@/components/pet/console/pet-console"

export default function PetPage() {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-auto">
      <PetConsole />
    </div>
  )
}
