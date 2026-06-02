// Terminal activity → pet events. Any running command makes the pet "think";
// when all commands finish it celebrates a small success.

import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { PetEmit } from "../pet-event-bus"
import { wireActivitySource } from "./activity-source"

export function anyTerminalRunning(): boolean {
  return Object.values(useTerminalStore.getState().sessions).some((s) => s.status === "running")
}

export function wireTerminalSource(emit: PetEmit): () => void {
  return wireActivitySource({
    subscribe: (listener) => useTerminalStore.subscribe(() => listener()),
    isActiveNow: anyTerminalRunning,
    source: "terminal",
    activeKind: "thinking",
    xpOnComplete: 1,
    emit,
  })
}
