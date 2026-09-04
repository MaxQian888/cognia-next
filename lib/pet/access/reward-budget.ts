// Daily reward budget for everything that can drive the pet's progression from
// outside the user's own hands. A localStorage day-keyed ledger (in-memory
// fallback off the DOM) tracks what each SUBJECT has granted today, and grants
// are clamped to the remainder rather than rejected, so a drained budget still
// leaves a nurture that settles needs and plays its flourish.
//
// The subject key is opaque. It was per-plugin when this lived under
// `lib/plugin/api/`, and it now also carries the agent, which spends one
// ledger under a single identity rather than a fresh allowance per session.
// The storage prefix keeps its original spelling so an existing day's ledger
// survives the move.
//
// Known limitation (documented, accepted): multi-window localStorage writes
// can race and slightly over-grant. This is an anti-abuse bound, not
// accounting, and the pet economy tolerates a few stray coins.

export const PET_DAILY_XP_BUDGET = 50
export const PET_DAILY_COIN_BUDGET = 100

const STORAGE_PREFIX = "cognia:plugin-pet-budget:"

interface BudgetLedger {
  [subjectKey: string]: { xp: number; coins: number }
}

export interface PetBudgetDeps {
  now?: () => number
  storage?: Pick<Storage, "getItem" | "setItem">
}

/** In-memory fallback when localStorage is unavailable (SSR / tests). */
const memoryStore = new Map<string, string>()
const memoryStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => {
    memoryStore.set(key, value)
  },
}

function resolveStorage(deps?: PetBudgetDeps): Pick<Storage, "getItem" | "setItem"> {
  if (deps?.storage) return deps.storage
  try {
    if (typeof localStorage !== "undefined") return localStorage
  } catch {
    // fall through to memory
  }
  return memoryStorage
}

function dayKey(now: number): string {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${STORAGE_PREFIX}${y}-${m}-${day}`
}

function readLedger(storage: Pick<Storage, "getItem" | "setItem">, key: string): BudgetLedger {
  try {
    const raw = storage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as BudgetLedger) : {}
  } catch {
    return {}
  }
}

function clampSpend(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0
}

/** Remaining daily XP/coin budget for one subject. */
export function getRemainingPetBudget(
  subjectKey: string,
  deps?: PetBudgetDeps
): { xp: number; coins: number } {
  const storage = resolveStorage(deps)
  const ledger = readLedger(storage, dayKey(deps?.now?.() ?? Date.now()))
  const spent = ledger[subjectKey]
  return {
    xp: Math.max(0, PET_DAILY_XP_BUDGET - clampSpend(spent?.xp)),
    coins: Math.max(0, PET_DAILY_COIN_BUDGET - clampSpend(spent?.coins)),
  }
}

/**
 * Clamp a requested grant to the subject's remaining budget for the current
 * local day, persist the consumption, and return what was actually granted.
 * Stale-day keys are simply never read again, a lazy reset with no scheduler.
 */
export function consumePetBudget(
  subjectKey: string,
  req: { xp?: number; coins?: number },
  deps?: PetBudgetDeps
): { grantedXp: number; grantedCoins: number } {
  const storage = resolveStorage(deps)
  const key = dayKey(deps?.now?.() ?? Date.now())
  const ledger = readLedger(storage, key)
  const spent = {
    xp: clampSpend(ledger[subjectKey]?.xp),
    coins: clampSpend(ledger[subjectKey]?.coins),
  }

  const clampAsk = (v?: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
  const askXp = clampAsk(req.xp)
  const askCoins = clampAsk(req.coins)
  const grantedXp = Math.min(askXp, Math.max(0, PET_DAILY_XP_BUDGET - spent.xp))
  const grantedCoins = Math.min(askCoins, Math.max(0, PET_DAILY_COIN_BUDGET - spent.coins))

  if (grantedXp > 0 || grantedCoins > 0) {
    ledger[subjectKey] = { xp: spent.xp + grantedXp, coins: spent.coins + grantedCoins }
    try {
      storage.setItem(key, JSON.stringify(ledger))
    } catch {
      // Quota or serialization failure. The grant still happened this session,
      // the ledger just under-records. Acceptable for an anti-abuse bound.
    }
  }
  return { grantedXp, grantedCoins }
}

export function __resetPetBudgetForTesting(): void {
  memoryStore.clear()
}
