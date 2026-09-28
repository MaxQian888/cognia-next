export interface OpticalShape {
  font?: string
  /** "sent" (hue per sentence) or "bw"; the renderer rejects anything else. */
  variant?: string
  cellWidth?: number
  cellHeight?: number
  lineRepeat?: number
  /** 1 (grid) or 2 (two-column doc). */
  columns?: number
}

export interface OpticalCompactionOptions extends OpticalShape {
  size?: number
  maxFrames?: number
  minCoverage?: number
  minSavings?: number
  verify?: boolean
  readabilityThreshold?: number
}
