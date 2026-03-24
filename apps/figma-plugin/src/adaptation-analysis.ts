import { computeBoundingBox } from '@create-figma-plugin/utilities'

import type {
  BoundingRect,
  FrameAnalysisPayload,
  FrameNodeAnalysis,
  NodeClassification
} from './adaptation-types'
import type { PresetId } from './messages'

type AnalyzeFrameOptions = {
  runId: string
  sourceFrame: FrameNode
  targetWidth: number
  targetHeight: number
  presetId: PresetId
  includeScreenshot: boolean
}

const MAX_ANALYSIS_NODES = 260

export async function analyzeFrameForAdaptation(
  options: AnalyzeFrameOptions
): Promise<FrameAnalysisPayload> {
  const {
    runId,
    sourceFrame,
    targetWidth,
    targetHeight,
    presetId,
    includeScreenshot
  } = options

  const rootRect = getNodeRect(sourceFrame)
  const fallbackRect = {
    x: sourceFrame.x,
    y: sourceFrame.y,
    width: sourceFrame.width,
    height: sourceFrame.height
  }
  const frameRect = rootRect ?? fallbackRect

  const nodes: Array<FrameNodeAnalysis> = []
  collectNodeAnalysis({
    node: sourceFrame,
    path: 'root',
    parentPath: null,
    rootRect: frameRect,
    nodes,
    zBase: 0
  })

  const screenshot = includeScreenshot
    ? await exportFrameScreenshot(sourceFrame)
    : null

  return {
    runId,
    sourceFrame: {
      nodeId: sourceFrame.id,
      name: sourceFrame.name,
      width: sourceFrame.width,
      height: sourceFrame.height
    },
    targetFrame: {
      width: targetWidth,
      height: targetHeight,
      presetId
    },
    nodes: nodes.slice(0, MAX_ANALYSIS_NODES),
    screenshot
  }
}

type CollectNodeOptions = {
  node: SceneNode
  path: string
  parentPath: string | null
  rootRect: BoundingRect
  nodes: Array<FrameNodeAnalysis>
  zBase: number
}

function collectNodeAnalysis(options: CollectNodeOptions): number {
  const { node, path, parentPath, rootRect, nodes, zBase } = options
  const nodeRect = getNodeRect(node)

  let nextZ = zBase
  if (nodeRect !== null) {
    const normalized = toNormalized(nodeRect, rootRect)
    const areaRatio =
      rootRect.width > 0 && rootRect.height > 0
        ? (nodeRect.width * nodeRect.height) / (rootRect.width * rootRect.height)
        : 0

    nodes.push({
      path,
      nodeId: node.id,
      name: node.name,
      type: node.type,
      parentPath,
      zIndex: nextZ,
      isVisible: node.visible,
      classification: classifyNode(node, normalized, areaRatio, path),
      absolute: nodeRect,
      normalized,
      textMeta: getTextMeta(node, nodeRect)
    })
    nextZ += 1
  }

  if ('children' in node) {
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index]
      const childPath = `${path}.${index}`
      nextZ = collectNodeAnalysis({
        node: child,
        path: childPath,
        parentPath: path,
        rootRect,
        nodes,
        zBase: nextZ
      })
      if (nodes.length >= MAX_ANALYSIS_NODES) {
        return nextZ
      }
    }
  }

  return nextZ
}

function getNodeRect(node: SceneNode): BoundingRect | null {
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

function toNormalized(rect: BoundingRect, rootRect: BoundingRect): FrameNodeAnalysis['normalized'] {
  const rootWidth = Math.max(1, rootRect.width)
  const rootHeight = Math.max(1, rootRect.height)

  const left = (rect.x - rootRect.x) / rootWidth
  const top = (rect.y - rootRect.y) / rootHeight
  const width = rect.width / rootWidth
  const height = rect.height / rootHeight

  const centerX = left + width / 2
  const centerY = top + height / 2

  return {
    left,
    top,
    width,
    height,
    centerX,
    centerY
  }
}

function classifyNode(
  node: SceneNode,
  normalized: FrameNodeAnalysis['normalized'],
  areaRatio: number,
  path: string
): NodeClassification {
  const lowerName = node.name.toLowerCase()

  if (path === 'root') {
    return 'CONTENT'
  }

  if (node.type === 'TEXT') {
    return 'TEXT'
  }

  if (isRailLikeNode(lowerName, normalized, areaRatio)) {
    return 'RAIL'
  }

  if (isMenuLikeNode(lowerName, normalized, areaRatio)) {
    return 'MENU'
  }

  if (isIconLikeNode(node, lowerName, areaRatio)) {
    return 'ICON'
  }

  const isLogoLike =
    lowerName.includes('logo') ||
    lowerName.includes('brand') ||
    lowerName.includes('mark') ||
    lowerName.includes('icon')

  if (isLogoLike && areaRatio <= 0.12) {
    return 'LOGO'
  }

  const isNearFullBleed =
    areaRatio >= 0.6 &&
    normalized.left <= 0.06 &&
    normalized.top <= 0.06 &&
    normalized.width >= 0.9 &&
    normalized.height >= 0.9

  if (isNearFullBleed) {
    return 'BACKGROUND'
  }

  if (node.type === 'LINE' || node.type === 'VECTOR') {
    return areaRatio <= 0.08 ? 'DECORATION' : 'CONTENT'
  }

  return 'CONTENT'
}

function isRailLikeNode(
  lowerName: string,
  normalized: FrameNodeAnalysis['normalized'],
  areaRatio: number
): boolean {
  const railNameHit =
    lowerName.includes('rail') ||
    lowerName.includes('sidebar') ||
    lowerName.includes('side bar') ||
    lowerName.includes('dock')

  const edgePinned = normalized.left <= 0.08 || normalized.left + normalized.width >= 0.92
  const tallAndNarrow = normalized.height >= 0.45 && normalized.width <= 0.32
  return railNameHit || (edgePinned && tallAndNarrow && areaRatio >= 0.05)
}

function isMenuLikeNode(
  lowerName: string,
  normalized: FrameNodeAnalysis['normalized'],
  areaRatio: number
): boolean {
  const menuNameHit =
    lowerName.includes('menu') ||
    lowerName.includes('nav') ||
    lowerName.includes('navigation') ||
    lowerName.includes('tabbar') ||
    lowerName.includes('tabs')

  const clusteredListShape = normalized.width <= 0.42 && normalized.height <= 0.45 && areaRatio >= 0.015
  return menuNameHit || clusteredListShape
}

function isIconLikeNode(node: SceneNode, lowerName: string, areaRatio: number): boolean {
  const nameSuggestsIcon =
    lowerName.includes('icon') ||
    lowerName.includes('glyph') ||
    lowerName.includes('badge') ||
    lowerName.includes('symbol')

  if (nameSuggestsIcon && areaRatio <= 0.12) {
    return true
  }

  const geometricIconTypes =
    node.type === 'VECTOR' ||
    node.type === 'BOOLEAN_OPERATION' ||
    node.type === 'ELLIPSE' ||
    node.type === 'POLYGON' ||
    node.type === 'STAR'

  return geometricIconTypes && areaRatio <= 0.045
}

function getTextMeta(
  node: SceneNode,
  rect: BoundingRect
): FrameNodeAnalysis['textMeta'] | undefined {
  if (node.type !== 'TEXT') {
    return undefined
  }

  const fontSizes = getTextNodeFontSizes(node)
  const avgFontSizeForLines =
    fontSizes.length > 0
      ? fontSizes.reduce((sum, value) => sum + value, 0) / fontSizes.length
      : 12

  const textLength = node.characters.length
  const estimatedLines = Math.max(1, Math.round(rect.height / Math.max(1, avgFontSizeForLines)))
  if (fontSizes.length === 0) {
    return {
      characters: textLength,
      estimatedLines,
      textAutoResize: node.textAutoResize,
      minFontSize: 0,
      maxFontSize: 0,
      avgFontSize: 0
    }
  }

  const minFontSize = Math.min(...fontSizes)
  const maxFontSize = Math.max(...fontSizes)
  const avgFontSize = fontSizes.reduce((sum, value) => sum + value, 0) / fontSizes.length

  return {
    characters: textLength,
    estimatedLines,
    textAutoResize: node.textAutoResize,
    minFontSize,
    maxFontSize,
    avgFontSize
  }
}

function getTextNodeFontSizes(node: TextNode): Array<number> {
  const values: Array<number> = []

  const fontSize = node.fontSize
  if (typeof fontSize === 'number') {
    values.push(fontSize)
    return values
  }

  const characters = node.characters.length
  for (let index = 0; index < characters; index += 1) {
    const rangeSize = node.getRangeFontSize(index, index + 1)
    if (typeof rangeSize === 'number') {
      values.push(rangeSize)
    }
  }

  return values
}

async function exportFrameScreenshot(
  frame: FrameNode
): Promise<FrameAnalysisPayload['screenshot']> {
  try {
    const bytes = await frame.exportAsync({
      format: 'PNG',
      constraint: {
        type: 'SCALE',
        value: 0.5
      }
    })

    return {
      mimeType: 'image/png',
      base64: bytesToBase64(bytes)
    }
  } catch (error) {
    console.warn('[adaptation:analysis-screenshot-export]', error)
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return figma.base64Encode(bytes)
}
