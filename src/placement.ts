import { computeBoundingBox } from '@create-figma-plugin/utilities'

import {
  computeUnion,
  isPointFree,
  type Point,
  type Rect,
  type Size
} from './placement-geometry'

const PLACEMENT_GAP = 24
const SEARCH_STEP = 24
const MAX_RING_COUNT = 320

export function findNearestAvailableFramePosition(
  sourceFrame: FrameNode,
  outputFrame: FrameNode
): Point | null {
  const sourceRect = getNodeRect(sourceFrame)
  if (sourceRect === null) {
    return null
  }

  const outputParent = outputFrame.parent
  if (outputParent === null || 'children' in outputParent === false) {
    return null
  }

  const outputSize: Size = {
    width: Math.max(1, outputFrame.width),
    height: Math.max(1, outputFrame.height)
  }

  const obstacles = collectVisibleSiblingRects(outputParent, outputFrame.id)
  const preferredRight: Point = {
    x: sourceRect.x + sourceRect.width + PLACEMENT_GAP,
    y: sourceRect.y
  }

  if (isPointFree(preferredRight, outputSize, obstacles, PLACEMENT_GAP)) {
    return preferredRight
  }

  const nearest = searchNearestFreePoint({
    origin: { x: sourceRect.x, y: sourceRect.y },
    outputSize,
    obstacles,
    sourceRect
  })
  if (nearest !== null) {
    return nearest
  }

  return findDeterministicFallback({
    sourceRect,
    outputSize,
    obstacles
  })
}

function searchNearestFreePoint(options: {
  origin: Point
  outputSize: Size
  obstacles: Array<Rect>
  sourceRect: Rect
}): Point | null {
  const { origin, outputSize, obstacles, sourceRect } = options
  const maxRing = computeMaxRingCount(origin, outputSize, obstacles, sourceRect)

  for (let ring = 1; ring <= maxRing; ring += 1) {
    const offsets = buildRingOffsets(ring)

    for (const offset of offsets) {
      const candidate: Point = {
        x: origin.x + offset.x * SEARCH_STEP,
        y: origin.y + offset.y * SEARCH_STEP
      }

      if (isPointFree(candidate, outputSize, obstacles, PLACEMENT_GAP)) {
        return candidate
      }
    }
  }

  return null
}

function computeMaxRingCount(
  origin: Point,
  outputSize: Size,
  obstacles: Array<Rect>,
  sourceRect: Rect
): number {
  const union = computeUnion([...obstacles, sourceRect])
  if (union === null) {
    return 8
  }

  const originRight = origin.x + outputSize.width
  const originBottom = origin.y + outputSize.height
  const spread = Math.max(
    Math.abs(union.x - origin.x),
    Math.abs(union.y - origin.y),
    Math.abs(union.x + union.width - originRight),
    Math.abs(union.y + union.height - originBottom)
  )

  const derivedRing = Math.ceil((spread + outputSize.width + outputSize.height + PLACEMENT_GAP * 2) / SEARCH_STEP)

  return Math.max(6, Math.min(MAX_RING_COUNT, derivedRing))
}

function findDeterministicFallback(options: {
  sourceRect: Rect
  outputSize: Size
  obstacles: Array<Rect>
}): Point {
  const { sourceRect, outputSize, obstacles } = options
  const union = computeUnion([...obstacles, sourceRect])

  if (union === null) {
    return {
      x: sourceRect.x + sourceRect.width + PLACEMENT_GAP,
      y: sourceRect.y
    }
  }

  const candidates: Array<Point> = [
    {
      x: union.x + union.width + PLACEMENT_GAP,
      y: sourceRect.y
    },
    {
      x: sourceRect.x,
      y: union.y + union.height + PLACEMENT_GAP
    },
    {
      x: union.x + union.width + PLACEMENT_GAP,
      y: union.y + union.height + PLACEMENT_GAP
    }
  ]

  for (const candidate of candidates) {
    if (isPointFree(candidate, outputSize, obstacles, PLACEMENT_GAP)) {
      return candidate
    }
  }

  return candidates[0]
}

function collectVisibleSiblingRects(parent: BaseNode & ChildrenMixin, excludeNodeId: string): Array<Rect> {
  const rects: Array<Rect> = []

  for (const child of parent.children) {
    if (child.id === excludeNodeId) {
      continue
    }

    if ('visible' in child && child.visible === false) {
      continue
    }

    const rect = getNodeRect(child)
    if (rect !== null) {
      rects.push(rect)
    }
  }

  return rects
}

function getNodeRect(node: SceneNode): Rect | null {
  if (node.absoluteBoundingBox !== null) {
    return {
      x: node.absoluteBoundingBox.x,
      y: node.absoluteBoundingBox.y,
      width: node.absoluteBoundingBox.width,
      height: node.absoluteBoundingBox.height
    }
  }

  try {
    const bounds = computeBoundingBox(node)
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    }
  } catch (_error) {
    return null
  }
}

function buildRingOffsets(ring: number): Array<{ x: number; y: number }> {
  const offsets: Array<{ x: number; y: number }> = []

  for (let y = -ring + 1; y <= ring; y += 1) {
    offsets.push({ x: ring, y })
  }

  for (let x = ring - 1; x >= -ring; x -= 1) {
    offsets.push({ x, y: ring })
  }

  for (let y = ring - 1; y >= -ring; y -= 1) {
    offsets.push({ x: -ring, y })
  }

  for (let x = -ring + 1; x <= ring; x += 1) {
    offsets.push({ x, y: -ring })
  }

  return offsets
}
