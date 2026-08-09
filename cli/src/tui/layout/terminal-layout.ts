export type TerminalLayoutTier = "full" | "medium" | "compact" | "tiny"
export type BannerDensity = "full" | "medium" | "compact"

export interface TerminalLayoutBudget {
  tier: TerminalLayoutTier
  bannerDensity: BannerDensity
  showBanner: boolean
  showMascot: boolean
  showFooterHint: boolean
  composerRows: number
}

/** Rows available to a panel body after its measured viewport chrome. */
export function contentRows(viewportRows: number, chromeRows: number): number {
  const viewport = Math.max(0, Math.floor(viewportRows))
  const chrome = Math.max(0, Math.floor(chromeRows))
  return Math.max(0, viewport - chrome)
}

export function terminalLayout(columns: number, rows: number): TerminalLayoutBudget {
  const width = Math.max(1, Math.floor(columns))
  const height = Math.max(1, Math.floor(rows))
  if (width < 40 || height < 12) {
    return {
      tier: "tiny",
      bannerDensity: "compact",
      showBanner: false,
      showMascot: false,
      showFooterHint: false,
      composerRows: 2,
    }
  }
  if (width < 60) {
    return {
      tier: "compact",
      bannerDensity: "compact",
      showBanner: true,
      showMascot: true,
      showFooterHint: false,
      composerRows: 2,
    }
  }
  if (width < 100) {
    return {
      tier: "medium",
      bannerDensity: "medium",
      showBanner: true,
      showMascot: true,
      showFooterHint: false,
      composerRows: 3,
    }
  }
  return {
    tier: "full",
    bannerDensity: "full",
    showBanner: true,
    showMascot: true,
    showFooterHint: true,
    composerRows: 3,
  }
}
