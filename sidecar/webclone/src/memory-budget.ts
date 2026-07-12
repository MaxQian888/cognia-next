import type { MemoryBudget, HtmlStrategy, CssStrategy, JsStrategy } from "./config/schema.js"

export type { MemoryBudget, HtmlStrategy, CssStrategy, JsStrategy }

const MB = 1024 * 1024
const KB = 1024

export function assessMemoryBudget(
  html: string,
  css: string,
  js: string,
  maxMemoryMB: number = 0
): MemoryBudget {
  const budget: MemoryBudget = {
    htmlParseBudget: maxMemoryMB > 0 ? maxMemoryMB * MB : 200 * MB,
    cssParseBudget: maxMemoryMB > 0 ? Math.floor((maxMemoryMB * MB) / 2) : 100 * MB,
    jsParseBudget: maxMemoryMB > 0 ? Math.floor((maxMemoryMB * MB) / 2) : 100 * MB,
    htmlStrategy: "full",
    cssStrategy: "full",
    jsStrategy: "full",
  }

  if (html.length > 2 * MB) budget.htmlStrategy = "streaming"
  if (html.length > 10 * MB) budget.htmlStrategy = "skip"

  if (css.length > 500 * KB) budget.cssStrategy = "head"
  if (css.length > 5 * MB) budget.cssStrategy = "skip"

  if (js.length > 1 * MB) budget.jsStrategy = "head"
  if (js.length > 5 * MB) budget.jsStrategy = "skip"

  return budget
}

export class MemoryWatchdog {
  private readonly maxMemoryMB: number
  private readonly warningThreshold: number
  private warningLogged = false

  constructor(maxMemoryMB: number = 1536) {
    this.maxMemoryMB = maxMemoryMB
    this.warningThreshold = maxMemoryMB * 0.8
  }

  check(): "ok" | "warning" | "critical" {
    const usage = process.memoryUsage().heapUsed / 1024 / 1024
    if (usage > this.maxMemoryMB) return "critical"
    if (usage > this.warningThreshold) {
      if (!this.warningLogged) {
        console.warn(`⚠ Memory warning: ${Math.round(usage)}MB used`)
        this.warningLogged = true
      }
      return "warning"
    }
    return "ok"
  }

  async guard(operation: () => Promise<void>): Promise<boolean> {
    const status = this.check()
    if (status === "critical") {
      console.warn("⚠ Memory budget exceeded, skipping remaining analysis")
      return false
    }
    await operation()
    return true
  }
}

export function formatDegradationSummary(budget: MemoryBudget): string[] {
  const degradations: string[] = []
  if (budget.htmlStrategy !== "full") degradations.push(`HTML: ${budget.htmlStrategy}`)
  if (budget.cssStrategy !== "full") degradations.push(`CSS: ${budget.cssStrategy}`)
  if (budget.jsStrategy !== "full") degradations.push(`JS: ${budget.jsStrategy}`)
  return degradations
}
