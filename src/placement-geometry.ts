import type { BoundingRect } from './adaptation-types'

export type Rect = BoundingRect

export type Point = {
  x: number
  y: number
}

export type Size = {
  width: number
  height: number
}

export function rectFromPoint(point: Point, size: Size): Rect {
  return {
    x: point.x,
    y: point.y,
    width: size.width,
    height: size.height
  }
}

export function intersectsWithGap(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x + a.width + gap > b.x &&
    b.x + b.width + gap > a.x &&
    a.y + a.height + gap > b.y &&
    b.y + b.height + gap > a.y
  )
}

export function collidesWithAny(rect: Rect, obstacles: Array<Rect>, gap: number): boolean {
  for (const obstacle of obstacles) {
    if (intersectsWithGap(rect, obstacle, gap)) {
      return true
    }
  }
  return false
}

export function isPointFree(point: Point, size: Size, obstacles: Array<Rect>, gap: number): boolean {
  const rect = rectFromPoint(point, size)
  return collidesWithAny(rect, obstacles, gap) === false
}

export function computeUnion(rects: Array<Rect>): Rect | null {
  if (rects.length === 0) {
    return null
  }

  let minX = rects[0].x
  let minY = rects[0].y
  let maxX = rects[0].x + rects[0].width
  let maxY = rects[0].y + rects[0].height

  for (let index = 1; index < rects.length; index += 1) {
    const rect = rects[index]
    minX = Math.min(minX, rect.x)
    minY = Math.min(minY, rect.y)
    maxX = Math.max(maxX, rect.x + rect.width)
    maxY = Math.max(maxY, rect.y + rect.height)
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  }
}
