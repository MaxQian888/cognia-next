export type TerminalLayoutTier = "full" | "medium" | "compact" | "tiny"
export type BannerDensity = "full" | "medium" | "compact"

export interface TerminalLayoutBudget {
  tier: TerminalLayoutTier
  bannerDensity: BannerDensity
  showBanner: boolean
  showMascot: boolean
  showFooterHint: boolean
  overlayFullscreen: boolean
  composerRows: number
  pathColumns: number
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
      overlayFullscreen: true,
      composerRows: 2,
      pathColumns: Math.max(8, width - 8),
    }
  }
  if (width < 60) {
    return {
      tier: "compact",
      bannerDensity: "compact",
      showBanner: true,
      showMascot: true,
      showFooterHint: false,
      overlayFullscreen: false,
      composerRows: 2,
      pathColumns: 20,
    }
  }
  if (width < 100) {
    return {
      tier: "medium",
      bannerDensity: "medium",
      showBanner: true,
      showMascot: true,
      showFooterHint: false,
      overlayFullscreen: false,
      composerRows: 3,
      pathColumns: 40,
    }
  }
  return {
    tier: "full",
    bannerDensity: "full",
    showBanner: true,
    showMascot: true,
    showFooterHint: true,
    overlayFullscreen: false,
    composerRows: 3,
    pathColumns: 80,
  }
}
