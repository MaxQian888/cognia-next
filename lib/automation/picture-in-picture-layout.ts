export const PICTURE_IN_PICTURE_EDGE_MARGIN = 24
export const PICTURE_IN_PICTURE_OBSTACLE_GAP = 12
export const PICTURE_IN_PICTURE_CHROME_HEIGHT = 36
export const PICTURE_IN_PICTURE_MIN_WIDTH = 220
export const PICTURE_IN_PICTURE_MIN_MEDIA_HEIGHT = 96
export const DEFAULT_PICTURE_IN_PICTURE_SIZE = { width: 250, height: 250 } as const

export type PictureInPictureAlignment = "topLeft" | "topRight" | "bottomLeft" | "bottomRight"

export interface PictureInPicturePoint {
  x: number
  y: number
}

export interface PictureInPictureRect extends PictureInPicturePoint {
  width: number
  height: number
}

export type PictureInPictureAnchors = Record<PictureInPictureAlignment, PictureInPicturePoint>

export interface PictureInPictureSizeInput {
  aspectRatio: number
  preferredLongEdge: number
  hostWidth: number
  hostHeight: number
}

export interface PictureInPictureMediaSize {
  width: number
  height: number
  mediaWidth: number
  mediaHeight: number
}

/**
 * Size the screenshot viewport first, then add toolbar chrome outside it.
 * This keeps the media box at the source ratio while ensuring portrait and
 * ultrawide frames still leave usable room for the header controls.
 */
export function computePictureInPictureSize({
  aspectRatio,
  preferredLongEdge,
  hostWidth,
  hostHeight,
}: PictureInPictureSizeInput): PictureInPictureMediaSize {
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1
  const longEdge =
    Number.isFinite(preferredLongEdge) && preferredLongEdge > 0 ? preferredLongEdge : 250
  let mediaWidth = ratio >= 1 ? longEdge : longEdge * ratio
  let mediaHeight = ratio >= 1 ? longEdge / ratio : longEdge

  const grow = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / mediaWidth,
    PICTURE_IN_PICTURE_MIN_MEDIA_HEIGHT / mediaHeight
  )
  mediaWidth *= grow
  mediaHeight *= grow

  const availableWidth = Math.max(1, hostWidth - PICTURE_IN_PICTURE_EDGE_MARGIN * 2)
  const availableMediaHeight = Math.max(
    1,
    hostHeight - PICTURE_IN_PICTURE_EDGE_MARGIN * 2 - PICTURE_IN_PICTURE_CHROME_HEIGHT
  )
  const shrink = Math.min(1, availableWidth / mediaWidth, availableMediaHeight / mediaHeight)
  mediaWidth = Math.max(1, Math.floor(mediaWidth * shrink))
  mediaHeight = Math.max(1, Math.floor(mediaHeight * shrink))

  return {
    width: mediaWidth,
    height: mediaHeight + PICTURE_IN_PICTURE_CHROME_HEIGHT,
    mediaWidth,
    mediaHeight,
  }
}

function overlapArea(a: PictureInPictureRect, b: PictureInPictureRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function resolveObstacles(
  initial: PictureInPicturePoint,
  host: PictureInPictureRect,
  obstacles: readonly PictureInPictureRect[],
  size: { width: number; height: number }
): PictureInPicturePoint {
  const minX = host.x + PICTURE_IN_PICTURE_EDGE_MARGIN
  const minY = host.y + PICTURE_IN_PICTURE_EDGE_MARGIN
  const maxX = host.x + host.width - size.width - PICTURE_IN_PICTURE_EDGE_MARGIN
  const maxY = host.y + host.height - size.height - PICTURE_IN_PICTURE_EDGE_MARGIN
  let point = { x: clamp(initial.x, minX, maxX), y: clamp(initial.y, minY, maxY) }

  for (let iteration = 0; iteration < 6; iteration++) {
    const rect = { ...point, ...size }
    const colliding = obstacles.filter((obstacle) => overlapArea(rect, obstacle) > 0)
    if (colliding.length === 0) break

    const candidates = colliding.flatMap((obstacle) => [
      { x: obstacle.x - PICTURE_IN_PICTURE_OBSTACLE_GAP - size.width, y: point.y },
      { x: obstacle.x + obstacle.width + PICTURE_IN_PICTURE_OBSTACLE_GAP, y: point.y },
      { x: point.x, y: obstacle.y - PICTURE_IN_PICTURE_OBSTACLE_GAP - size.height },
      { x: point.x, y: obstacle.y + obstacle.height + PICTURE_IN_PICTURE_OBSTACLE_GAP },
    ])
    const scored = candidates.map((candidate) => {
      const clamped = {
        x: clamp(candidate.x, minX, maxX),
        y: clamp(candidate.y, minY, maxY),
      }
      const candidateRect = { ...clamped, ...size }
      const overlap = obstacles.reduce(
        (sum, obstacle) => sum + overlapArea(candidateRect, obstacle),
        0
      )
      const movement = Math.abs(clamped.x - initial.x) + Math.abs(clamped.y - initial.y)
      return { point: clamped, score: overlap * 1_000_000 + movement }
    })
    scored.sort((a, b) => a.score - b.score)
    const next = scored[0]?.point
    if (!next || (next.x === point.x && next.y === point.y)) break
    point = next
  }

  return point
}

/**
 * Port of Codex's remote-hosted PiP anchor model. It exposes all four
 * collision-resolved corners so the UI can retain a user's preferred corner
 * without allowing the surface to cover thread controls.
 */
export function computePictureInPictureAnchors(
  host: PictureInPictureRect,
  obstacles: readonly PictureInPictureRect[],
  size: { width: number; height: number } = DEFAULT_PICTURE_IN_PICTURE_SIZE
): PictureInPictureAnchors {
  const left = host.x + PICTURE_IN_PICTURE_EDGE_MARGIN
  const right = host.x + host.width - size.width - PICTURE_IN_PICTURE_EDGE_MARGIN
  const top = host.y + PICTURE_IN_PICTURE_EDGE_MARGIN
  const bottom = host.y + host.height - size.height - PICTURE_IN_PICTURE_EDGE_MARGIN

  return {
    topLeft: resolveObstacles({ x: left, y: top }, host, obstacles, size),
    topRight: resolveObstacles({ x: right, y: top }, host, obstacles, size),
    bottomLeft: resolveObstacles({ x: left, y: bottom }, host, obstacles, size),
    bottomRight: resolveObstacles({ x: right, y: bottom }, host, obstacles, size),
  }
}
