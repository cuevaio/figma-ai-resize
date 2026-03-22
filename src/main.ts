import { showUI } from '@create-figma-plugin/utilities'

import { requestDirectLayoutPlan, requestRefinedLayoutPlan } from './ai-client'
import { analyzeFrameForAdaptation } from './adaptation-analysis'
import { applyAdaptationPlan, applyAdaptationPlanToFrame } from './adaptation-apply'
import {
  ASPECT_RATIO_PRESETS,
  DEFAULT_PRESET_ID,
  type AdaptationStatePayload,
  type InitSelectionStatePayload,
  type InvalidSelectionReason,
  type MainToUiMessage,
  type PresetId,
  type StartAdaptationPayload,
  type UiToMainMessage
} from './messages'

import type { AdaptationWarning, FrameAnalysisPayload } from './adaptation-types'

const UI_OPTIONS = {
  width: 360,
  height: 540
}

const REFINE_PASS_COUNT = 3
const ADAPTATION_PASS_COUNT = 1 + REFINE_PASS_COUNT

type AdaptationSession = {
  sourceFrameId: string
  sourceName: string
  analysis: FrameAnalysisPayload
  presetId: PresetId
  lastState: AdaptationStatePayload | null
}

const adaptationSessions = new Map<string, AdaptationSession>()

function hasActiveAdaptationSession(): boolean {
  return adaptationSessions.size > 0
}

function getActiveAdaptationState(): AdaptationStatePayload | null {
  let latestState: AdaptationStatePayload | null = null
  adaptationSessions.forEach((session) => {
    if (session.lastState !== null) {
      latestState = session.lastState
    }
  })
  return latestState
}

export default function () {
  showUI(UI_OPTIONS, getSelectionState())

  figma.on('selectionchange', postSelectionState)
  figma.on('currentpagechange', postSelectionState)

  postSelectionState()

  figma.ui.onmessage = (message: UiToMainMessage) => {
    if (message.type === 'START_ADAPTATION') {
      if (hasActiveAdaptationSession()) {
        figma.notify('Adaptation is already running.')
        return
      }
      void handleStartAdaptation(message.payload)
      return
    }

    if (message.type === 'REQUEST_ADAPTATION_REHYDRATE') {
      const rehydrateMessage: MainToUiMessage = {
        type: 'ADAPTATION_REHYDRATE',
        payload: {
          activeRun: getActiveAdaptationState()
        }
      }
      figma.ui.postMessage(rehydrateMessage)
      return
    }
  }
}

function getSelectionState(): InitSelectionStatePayload {
  const selectedFrame = getSelectedFrame()
  if ('reason' in selectedFrame) {
    return {
      valid: false,
      reason: selectedFrame.reason,
      presets: ASPECT_RATIO_PRESETS,
      defaultPresetId: DEFAULT_PRESET_ID
    }
  }

  const frame = selectedFrame.frame
  return {
    valid: true,
    selection: {
      nodeId: frame.id,
      name: frame.name,
      width: frame.width,
      height: frame.height
    },
    presets: ASPECT_RATIO_PRESETS,
    defaultPresetId: DEFAULT_PRESET_ID
  }
}

function postSelectionState(): void {
  const message: MainToUiMessage = {
    type: 'SELECTION_STATE',
    payload: getSelectionState()
  }
  figma.ui.postMessage(message)
}

function getSelectedFrame():
  | { frame: FrameNode }
  | { reason: InvalidSelectionReason } {
  const selection = figma.currentPage.selection

  if (selection.length === 0) {
    return { reason: 'NO_SELECTION' }
  }

  if (selection.length > 1) {
    return { reason: 'MULTI_SELECTION' }
  }

  const selectedNode = selection[0]
  if (selectedNode.type !== 'FRAME') {
    return { reason: 'NOT_FRAME' }
  }

  return { frame: selectedNode }
}

async function handleStartAdaptation(payload: StartAdaptationPayload): Promise<void> {
  const { runId, presetId, includeScreenshot } = payload

  postAdaptationState(runId, 0, ADAPTATION_PASS_COUNT, 'ANALYZING', 'Analyzing selected frame...')

  const preset = ASPECT_RATIO_PRESETS.find((item) => item.id === presetId)
  if (typeof preset === 'undefined') {
    postAdaptationError(runId, 0, ADAPTATION_PASS_COUNT, 'Invalid preset selected.')
    return
  }

  const selectedFrame = getSelectedFrame()
  if ('reason' in selectedFrame) {
    postAdaptationError(runId, 0, ADAPTATION_PASS_COUNT, 'Select a single frame to run adaptation.')
    postSelectionState()
    return
  }

  const sourceFrame = selectedFrame.frame
  const ratio = preset.width / preset.height
  const targetSize = computeTargetSize(sourceFrame.width, sourceFrame.height, ratio)

  let analysis: FrameAnalysisPayload
  try {
    analysis = await analyzeFrameForAdaptation({
      runId,
      sourceFrame,
      targetWidth: targetSize.width,
      targetHeight: targetSize.height,
      presetId,
      includeScreenshot
    })
  } catch (error) {
    console.error('[adaptation:analyze]', error)
    postAdaptationError(
      runId,
      0,
      ADAPTATION_PASS_COUNT,
      `Could not analyze frame for adaptation. ${toMessage(error)}`
    )
    return
  }

  if (analysis.screenshot === null) {
    postAdaptationError(
      runId,
      0,
      ADAPTATION_PASS_COUNT,
      'Source screenshot is missing. Screenshot upload requires image export.'
    )
    return
  }

  const session: AdaptationSession = {
    sourceFrameId: sourceFrame.id,
    sourceName: sourceFrame.name,
    analysis,
    presetId,
    lastState: null
  }
  adaptationSessions.set(runId, session)

  const analysisMessage: MainToUiMessage = {
    type: 'ANALYSIS_READY',
    payload: {
      runId,
      analysis
    }
  }
  figma.ui.postMessage(analysisMessage)

  await runSingleAdaptationPass(runId)
}

async function runSingleAdaptationPass(runId: string): Promise<void> {
  const session = adaptationSessions.get(runId)
  if (typeof session === 'undefined') {
    return
  }

  const sourceFrame = getSourceFrameFromSession(session)
  if (sourceFrame === null) {
    adaptationSessions.delete(runId)
    postAdaptationError(
      runId,
      0,
      ADAPTATION_PASS_COUNT,
      `Original frame "${session.sourceName}" is no longer available.`
    )
    return
  }

  postAdaptationState(runId, 1, ADAPTATION_PASS_COUNT, 'PLANNING', 'Generating layout...')

  let plan: Awaited<ReturnType<typeof requestDirectLayoutPlan>>
  try {
    plan = await requestDirectLayoutPlan({
      analysis: session.analysis
    })
  } catch (error) {
    console.error('[adaptation:plan]', error)
    adaptationSessions.delete(runId)
    postAdaptationError(
      runId,
      1,
      ADAPTATION_PASS_COUNT,
      `Failed to generate AI layout for frame "${session.sourceName}". ${toMessage(error)}`
    )
    return
  }

  postAdaptationState(runId, 1, ADAPTATION_PASS_COUNT, 'APPLYING', 'Applying generated layout...')

  let applyResult: Awaited<ReturnType<typeof applyAdaptationPlan>>
  try {
    applyResult = await applyAdaptationPlan({
      sourceFrame,
      analysis: session.analysis,
      plan,
      presetId: session.presetId,
      candidateNameSuffix: ''
    })
  } catch (error) {
    console.error('[adaptation:apply]', error)
    adaptationSessions.delete(runId)
    postAdaptationError(
      runId,
      1,
      ADAPTATION_PASS_COUNT,
      `Could not apply adaptation to frame "${session.sourceName}". ${toMessage(error)}`
    )
    return
  }

  let completedPass = 1
  const finalFrame = applyResult.frame
  const finalWarnings = [...applyResult.warnings]

  for (let refineIndex = 1; refineIndex <= REFINE_PASS_COUNT; refineIndex += 1) {
    const pass = 1 + refineIndex
    try {
      postAdaptationState(
        runId,
        pass,
        ADAPTATION_PASS_COUNT,
        'PLANNING',
        `Refining generated layout (pass ${pass}/${ADAPTATION_PASS_COUNT})...`
      )

      const refineAnalysis = await analyzeFrameForAdaptation({
        runId,
        sourceFrame: finalFrame,
        targetWidth: Math.max(1, Math.round(finalFrame.width)),
        targetHeight: Math.max(1, Math.round(finalFrame.height)),
        presetId: session.presetId,
        includeScreenshot: true
      })

      if (refineAnalysis.screenshot === null) {
        throw new Error('Refine screenshot export failed.')
      }

      const refinedPlan = await requestRefinedLayoutPlan({
        analysis: refineAnalysis,
        referenceScreenshot: session.analysis.screenshot,
        referenceFrameId: session.sourceFrameId
      })

      postAdaptationState(
        runId,
        pass,
        ADAPTATION_PASS_COUNT,
        'APPLYING',
        `Applying refined layout (pass ${pass}/${ADAPTATION_PASS_COUNT})...`
      )

      const refinedApplyResult = await applyAdaptationPlanToFrame({
        targetFrame: finalFrame,
        analysis: refineAnalysis,
        plan: refinedPlan
      })

      completedPass = pass
      finalWarnings.push(...refinedApplyResult.warnings)
    } catch (error) {
      console.error('[adaptation:refine]', error)
      figma.notify(`Refine pass ${pass}/${ADAPTATION_PASS_COUNT} failed. Kept previous result.`)
      break
    }
  }

  const screenshot = await exportFrameScreenshot(finalFrame)

  const passMessage: MainToUiMessage = {
    type: 'APPLY_RESULT',
    payload: {
      runId,
      pass: completedPass,
      maxPasses: ADAPTATION_PASS_COUNT,
      createdFrameId: finalFrame.id,
      screenshot,
      metrics: applyResult.metrics,
      warnings: finalWarnings,
      isFinalPass: true
    }
  }
  figma.ui.postMessage(passMessage)

  finalizeSession(runId, finalFrame.id, finalWarnings, completedPass, ADAPTATION_PASS_COUNT)
}

function finalizeSession(
  runId: string,
  selectedFrameId: string,
  warnings: Array<AdaptationWarning>,
  pass: number,
  maxPasses: number
): void {
  const session = adaptationSessions.get(runId)
  if (typeof session === 'undefined') {
    return
  }

  const selectedNode = figma.getNodeById(selectedFrameId)
  if (selectedNode === null || selectedNode.type !== 'FRAME') {
    adaptationSessions.delete(runId)
    postAdaptationError(runId, pass, maxPasses, 'Final adapted frame not found.')
    return
  }

  if (warnings.length > 0) {
    figma.notify(`Adaptation completed with ${warnings.length} warning(s).`)
  } else {
    figma.notify('Adaptation completed.')
  }

  figma.currentPage.selection = [selectedNode]
  figma.viewport.scrollAndZoomIntoView([selectedNode])

  postAdaptationState(runId, pass, maxPasses, 'FINALIZING', 'Finalizing output...')
  postAdaptationState(runId, pass, maxPasses, 'COMPLETED', 'Adaptation completed.')

  adaptationSessions.delete(runId)
}

function getSourceFrameFromSession(session: AdaptationSession): FrameNode | null {
  const sourceNode = figma.getNodeById(session.sourceFrameId)
  if (sourceNode === null || sourceNode.type !== 'FRAME') {
    return null
  }
  return sourceNode
}

function postAdaptationState(
  runId: string,
  pass: number,
  maxPasses: number,
  stage: 'IDLE' | 'ANALYZING' | 'PLANNING' | 'APPLYING' | 'FINALIZING' | 'COMPLETED' | 'FAILED',
  message: string
): void {
  const session = adaptationSessions.get(runId)
  if (typeof session !== 'undefined') {
    session.lastState = {
      runId,
      pass,
      maxPasses,
      stage,
      message
    }
    adaptationSessions.set(runId, session)
  }

  const stateMessage: MainToUiMessage = {
    type: 'ADAPTATION_STATE',
    payload: {
      runId,
      pass,
      maxPasses,
      stage,
      message
    }
  }
  figma.ui.postMessage(stateMessage)
}

function postAdaptationError(
  runId: string,
  pass: number,
  maxPasses: number,
  message: string
): void {
  const errorMessage: MainToUiMessage = {
    type: 'ADAPTATION_ERROR',
    payload: {
      runId,
      message
    }
  }
  figma.ui.postMessage(errorMessage)
  postAdaptationState(runId, pass, maxPasses, 'FAILED', message)
}

function computeTargetSize(
  currentWidth: number,
  currentHeight: number,
  targetRatio: number
): { width: number; height: number } {
  const preserveWidthHeight = currentWidth / targetRatio
  const preserveHeightWidth = currentHeight * targetRatio

  const preserveWidthDelta = Math.abs(preserveWidthHeight - currentHeight)
  const preserveHeightDelta = Math.abs(preserveHeightWidth - currentWidth)

  const shouldPreserveWidth = preserveWidthDelta <= preserveHeightDelta

  const width = shouldPreserveWidth ? currentWidth : preserveHeightWidth
  const height = shouldPreserveWidth ? preserveWidthHeight : currentHeight

  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  }
}

async function exportFrameScreenshot(
  frame: FrameNode
): Promise<{ mimeType: 'image/png'; base64: string } | null> {
  try {
    const bytes = await frame.exportAsync({
      format: 'PNG',
      constraint: {
        type: 'SCALE',
        value: 0.35
      }
    })
    return {
      mimeType: 'image/png',
      base64: bytesToBase64(bytes)
    }
  } catch (_error) {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return figma.base64Encode(bytes)
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
