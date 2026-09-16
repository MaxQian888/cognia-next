/**
 * Integer money (DESIGN §13.1). 1 USD = 1,000,000 microusd. Nothing here ever
 * touches a binary float: decimal strings are parsed into scaled BigInts, cost
 * is computed per billing bucket with an exact ceiling division, and only the
 * final safe integer leaves this module.
 */

export type Microusd = number

export const MICROUSD_PER_USD = 1_000_000

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const ZERO = BigInt(0)
const ONE = BigInt(1)
const TEN = BigInt(10)

export class MoneyError extends Error {
  readonly code = "MONEY_INVALID"
  constructor(message: string) {
    super(message)
    this.name = "MoneyError"
  }
}

/** A non-negative decimal as `numerator / 10^scale`, exactly. */
export interface ScaledDecimal {
  numerator: bigint
  scale: number
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/

export function parseDecimal(value: string): ScaledDecimal {
  const match = DECIMAL.exec(value)
  if (!match) throw new MoneyError(`not a non-negative decimal: ${JSON.stringify(value)}`)
  const whole = match[1]
  const fraction = match[2] ?? ""
  return { numerator: BigInt(whole + fraction), scale: fraction.length }
}

/** Exact ordering of two non-negative decimal strings: -1, 0 or 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  const scale = Math.max(x.scale, y.scale)
  const left = x.numerator * pow10(scale - x.scale)
  const right = y.numerator * pow10(scale - y.scale)
  return left === right ? 0 : left < right ? -1 : 1
}

function pow10(exponent: number): bigint {
  let out = ONE
  for (let i = 0; i < exponent; i++) out *= TEN
  return out
}

function toSafeNumber(value: bigint): Microusd {
  if (value < ZERO) throw new MoneyError("negative money amount")
  if (value > MAX_SAFE) throw new MoneyError("money amount exceeds the safe integer range")
  return Number(value)
}

/** Ceiling of `a / b` for non-negative BigInts. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - ONE) / b
}

/** Parse an API money string (≤ 6 decimals) into microusd, exactly. */
export function usdToMicrousd(value: string): Microusd {
  const { numerator, scale } = parseDecimal(value)
  if (scale > 6) throw new MoneyError(`more than 6 decimal places: ${value}`)
  return toSafeNumber(numerator * pow10(6 - scale))
}

/** Format microusd as the API's decimal string with exactly six fractional digits. */
export function microusdToUsd(amount: Microusd): string {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new MoneyError(`not a non-negative safe integer: ${amount}`)
  }
  const whole = Math.floor(amount / MICROUSD_PER_USD)
  const fraction = String(amount % MICROUSD_PER_USD).padStart(6, "0")
  return `${whole}.${fraction}`
}

/**
 * Cost of `quantity` units priced at `ratePerMillion` USD per million units,
 * rounded UP to the next microusd. A token priced in USD/1M costs exactly
 * `rate` microusd per token, so the bucket amount is `ceil(quantity × rate)`.
 */
export function costForQuantity(quantity: number, ratePerMillion: string): Microusd {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError(`quantity must be a non-negative safe integer: ${quantity}`)
  }
  const rate = parseDecimal(ratePerMillion)
  if (quantity === 0 || rate.numerator === ZERO) return 0
  return toSafeNumber(ceilDiv(BigInt(quantity) * rate.numerator, pow10(rate.scale)))
}

/** Cost of `count` flat per-call charges priced at `usdPerCall`, rounded up. */
export function costPerCall(count: number, usdPerCall: string): Microusd {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new MoneyError(`count must be a non-negative safe integer: ${count}`)
  }
  const rate = parseDecimal(usdPerCall)
  if (count === 0 || rate.numerator === ZERO) return 0
  const scaled = BigInt(count) * rate.numerator * pow10(6)
  return toSafeNumber(ceilDiv(scaled, pow10(rate.scale)))
}

export function addMicrousd(...amounts: Microusd[]): Microusd {
  let total = ZERO
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new MoneyError(`not a non-negative safe integer: ${amount}`)
    }
    total += BigInt(amount)
  }
  return toSafeNumber(total)
}

/** `a - b`, clamped at zero. Callers that must not clamp check `a >= b` first. */
export function subtractMicrousdFloor(a: Microusd, b: Microusd): Microusd {
  return a > b ? a - b : 0
}
