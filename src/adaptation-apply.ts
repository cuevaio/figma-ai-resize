import { setAbsolutePosition } from '@create-figma-plugin/utilities'

import type {
  AdaptationMetrics,
  AdaptationWarning,
  FrameAnalysisPayload,
  LlmLayoutPlan,
  LlmNodePlan
} from './adaptation-types'
import type { PresetId } from './messages'
import { findNearestAvailableFramePosition } from './placement'

type ApplyAdaptationOptions = {
  sourceFrame: FrameNode
  analysis: FrameAnalysisPayload
  plan: LlmLayoutPlan
  presetId: PresetId
  candidateNameSuffix: string
}

type ApplyAdaptationToExistingFrameOptions = {
  targetFrame: FrameNode
  analysis: FrameAnalysisPayload
  plan: LlmLayoutPlan
}

export async function applyAdaptationPlan(
  options: ApplyAdaptationOptions
): Promise<{ frame: FrameNode; warnings: Array<AdaptationWarning>; metrics: AdaptationMetrics }> {
  const { sourceFrame, analysis, plan, presetId, candidateNameSuffix } = options
  const warnings: Array<AdaptationWarning> = []

  const outputFrame = sourceFrame.clone()
  outputFrame.name = `${sourceFrame.name} (adapted ${presetId}${candidateNameSuffix})`
  outputFrame.resize(analysis.targetFrame.width, analysis.targetFrame.height)

  const outputParent = outputFrame.parent
  if (outputParent !== null && 'appendChild' in outputParent && isAutoLayoutParent(outputParent)) {
    const sourceIndex = outputParent.children.indexOf(sourceFrame)
    if (sourceIndex >= 0) {
      outputParent.insertChild(sourceIndex + 1, outputFrame)
    }
  } else {
    const position = findNearestAvailableFramePosition(sourceFrame, outputFrame)
    if (position !== null) {
      setAbsolutePosition(outputFrame, position)
    }
  }

  try {
    const applyResult = await applyPlanToFrame({
      frame: outputFrame,
      analysis,
      plan
    })
    warnings.push(...applyResult.warnings)
  } catch (error) {
    outputFrame.remove()
    throw error
  }

  return {
    frame: outputFrame,
    warnings,
    metrics: {
      textWrapRisk: 0,
      textHierarchyRisk: 0,
      anchorDriftRisk: 0,
      iconDistortionRisk: 0,
      railIntegrityRisk: 0,
      overallRisk: 0
    }
  }
}

export async function applyAdaptationPlanToFrame(
  options: ApplyAdaptationToExistingFrameOptions
): Promise<{ frame: FrameNode; warnings: Array<AdaptationWarning>; metrics: AdaptationMetrics }> {
  const { targetFrame, analysis, plan } = options
  const applyResult = await applyPlanToFrame({
    frame: targetFrame,
    analysis,
    plan
  })

  return {
    frame: targetFrame,
    warnings: applyResult.warnings,
    metrics: {
      textWrapRisk: 0,
      textHierarchyRisk: 0,
      anchorDriftRisk: 0,
      iconDistortionRisk: 0,
      railIntegrityRisk: 0,
      overallRisk: 0
    }
  }
}

async function applyPlanToFrame(options: {
  frame: FrameNode
  analysis: FrameAnalysisPayload
  plan: LlmLayoutPlan
}): Promise<{ warnings: Array<AdaptationWarning> }> {
  const { frame, analysis, plan } = options
  const warnings: Array<AdaptationWarning> = []

  assertPlanNodeCoverage(plan, analysis)

  const operationMap = new Map<string, LlmNodePlan>()
  for (const operation of plan.nodes) {
    operationMap.set(operation.path, operation)
  }

  const sortedNodes = [...analysis.nodes].sort((a, b) => a.zIndex - b.zIndex)

  for (const analyzedNode of sortedNodes) {
    if (analyzedNode.path === 'root') {
      continue
    }

    const clonedNode = getNodeByPath(frame, analyzedNode.path)
    if (clonedNode === null) {
      throw new Error(`Node missing in target frame at path ${analyzedNode.path}.`)
    }

    const operation = operationMap.get(analyzedNode.path)
    if (typeof operation === 'undefined') {
      throw new Error(`AI layout omitted required node path ${analyzedNode.path}.`)
    }

    const warning = await applyNodeOperation(frame, clonedNode, operation)
    if (warning !== null) {
      warnings.push({
        ...warning,
        path: analyzedNode.path
      })
    }
  }

  return {
    warnings
  }
}

function assertPlanNodeCoverage(plan: LlmLayoutPlan, analysis: FrameAnalysisPayload): void {
  const expectedPaths = analysis.nodes
    .filter((node) => node.path !== 'root')
    .map((node) => node.path)
  const expectedSet = new Set(expectedPaths)

  if (expectedSet.size === 0) {
    throw new Error('No analysable nodes were found in selected frame.')
  }

  if (plan.targetFrame.width !== analysis.targetFrame.width || plan.targetFrame.height !== analysis.targetFrame.height) {
    throw new Error('AI layout targetFrame does not match computed target dimensions.')
  }

  if (plan.nodes.length !== expectedSet.size) {
    throw new Error('AI layout must include exactly one entry for every non-root node path.')
  }

  for (const operation of plan.nodes) {
    if (!expectedSet.has(operation.path)) {
      throw new Error(`AI layout returned unknown node path ${operation.path}.`)
    }
  }

  for (const expectedPath of Array.from(expectedSet)) {
    const found = plan.nodes.some((node) => node.path === expectedPath)
    if (!found) {
      throw new Error(`AI layout is missing required node path ${expectedPath}.`)
    }
  }
}

async function applyNodeOperation(
  clonedFrame: FrameNode,
  clonedNode: SceneNode,
  operation: LlmNodePlan
): Promise<AdaptationWarning | null> {
  let fontLoadWarning: AdaptationWarning | null = null

  if (clonedNode.type === 'TEXT') {
    const missingFonts = await loadAllFontsForNode(clonedNode)
    if (operation.fontSize !== null && missingFonts.length === 0) {
      applyFontSize(clonedNode, operation.fontSize)
    }

    if (missingFonts.length > 0) {
      const fontList = missingFonts
        .map((font) => `${font.family} ${font.style}`)
        .join(', ')
      fontLoadWarning = {
        code: 'FONT_LOAD_FAILED',
        message:
          `Could not load source font(s): ${fontList}. ` +
          'Kept original text style and skipped AI font size for this node.'
      }
    }
  }

  if (!supportsResize(clonedNode)) {
    throw new Error(`Node at path ${operation.path} does not support resize.`)
  }

  clonedNode.resize(
    Math.max(1, Math.round(operation.width)),
    Math.max(1, Math.round(operation.height))
  )

  const frameRect = getFrameRect(clonedFrame)
  setAbsolutePosition(clonedNode, {
    x: frameRect.x + Math.round(operation.x),
    y: frameRect.y + Math.round(operation.y)
  })

  return fontLoadWarning
}

function applyFontSize(textNode: TextNode, fontSize: number): void {
  const normalizedFontSize = Math.max(1, Math.round(fontSize))
  const characters = textNode.characters.length
  if (characters === 0) {
    return
  }

  if (typeof textNode.fontSize === 'number') {
    textNode.fontSize = normalizedFontSize
    return
  }

  for (let index = 0; index < characters; index += 1) {
    textNode.setRangeFontSize(index, index + 1, normalizedFontSize)
  }
}

async function loadAllFontsForNode(textNode: TextNode): Promise<Array<FontName>> {
  const fonts = new Map<string, FontName>()

  const uniformFont = textNode.fontName
  if (uniformFont !== figma.mixed) {
    fonts.set(`${uniformFont.family}-${uniformFont.style}`, uniformFont)
  } else {
    const characters = textNode.characters.length
    for (let index = 0; index < characters; index += 1) {
      const fontName = textNode.getRangeFontName(index, index + 1)
      if (fontName === figma.mixed) {
        continue
      }
      fonts.set(`${fontName.family}-${fontName.style}`, fontName)
    }
  }

  const fontList = Array.from(fonts.values())
  const missingFonts: Array<FontName> = []
  for (let index = 0; index < fontList.length; index += 1) {
    try {
      await figma.loadFontAsync(fontList[index])
    } catch (_error) {
      missingFonts.push(fontList[index])
    }
  }

  return missingFonts
}

function getNodeByPath(root: SceneNode, path: string): SceneNode | null {
  if (path === 'root') {
    return root
  }

  const segments = path.split('.').slice(1)
  let current: SceneNode = root

  for (const segment of segments) {
    const index = Number(segment)
    if (Number.isInteger(index) === false || index < 0) {
      return null
    }

    if ('children' in current === false) {
      return null
    }

    const nextNode = current.children[index]
    if (typeof nextNode === 'undefined') {
      return null
    }
    current = nextNode
  }

  return current
}

function getFrameRect(frame: FrameNode): { x: number; y: number } {
  if (frame.absoluteBoundingBox !== null) {
    return {
      x: frame.absoluteBoundingBox.x,
      y: frame.absoluteBoundingBox.y
    }
  }
  return {
    x: frame.x,
    y: frame.y
  }
}

function supportsResize(node: SceneNode): node is SceneNode & LayoutMixin {
  return 'resize' in node
}

function isAutoLayoutParent(
  parent: BaseNode & ChildrenMixin
): parent is (BaseNode & ChildrenMixin & AutoLayoutMixin) {
  return 'layoutMode' in parent && parent.layoutMode !== 'NONE'
}
