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
  type RequestRefinePayload,
  type ResetSessionPayload,
  type StartAdaptationPayload,
  type UiToMainMessage
} from './messages'

import type { FrameAnalysisPayload } from './adaptation-types'

const UI_OPTIONS = {
  width: 360,
  height: 540
}

type AdaptationSession = {
  sourceFrameId: string
  sourceName: string
  sourceWidth: number
  sourceHeight: number
  analysis: FrameAnalysisPayload
  presetId: PresetId
  lastState: AdaptationStatePayload | null
  outputFrameId: string | null
  refineCount: number
  busy: boolean
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

function getActiveSessionEntry(): { runId: string; session: AdaptationSession } | null {
  let result: { runId: string; session: AdaptationSession } | null = null
  adaptationSessions.forEach((session, runId) => {
    if (session.outputFrameId !== null) {
      result = { runId, session }
    }
  })
  return result
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

    if (message.type === 'REQUEST_REFINE') {
      void handleRequestRefine(message.payload)
      return
    }

    if (message.type === 'RESET_SESSION') {
      handleResetSession(message.payload)
      return
    }

    if (message.type === 'REQUEST_ADAPTATION_REHYDRATE') {
      const activeEntry = getActiveSessionEntry()
      const rehydrateMessage: MainToUiMessage = {
        type: 'ADAPTATION_REHYDRATE',
        payload: {
          activeRun: getActiveAdaptationState(),
          session: activeEntry !== null ? {
            runId: activeEntry.runId,
            lockedSelection: {
              nodeId: activeEntry.session.sourceFrameId,
              name: activeEntry.session.sourceName,
              width: activeEntry.session.sourceWidth,
              height: activeEntry.session.sourceHeight
            },
            refineCount: activeEntry.session.refineCount,
            createdFrameId: activeEntry.session.outputFrameId!
          } : null
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
  if (hasActiveAdaptationSession()) return

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

  postAdaptationState(runId, 0, 'ANALYZING', 'Analyzing selected frame...')

  const preset = ASPECT_RATIO_PRESETS.find((item) => item.id === presetId)
  if (typeof preset === 'undefined') {
    postAdaptationError(runId, 0, 'Invalid preset selected.')
    return
  }

  const selectedFrame = getSelectedFrame()
  if ('reason' in selectedFrame) {
    postAdaptationError(runId, 0, 'Select a single frame to run adaptation.')
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
      `Could not analyze frame for adaptation. ${toMessage(error)}`
    )
    return
  }

  if (analysis.screenshot === null) {
    postAdaptationError(
      runId,
      0,
      'Source screenshot is missing. Screenshot upload requires image export.'
    )
    return
  }

  const session: AdaptationSession = {
    sourceFrameId: sourceFrame.id,
    sourceName: sourceFrame.name,
    sourceWidth: sourceFrame.width,
    sourceHeight: sourceFrame.height,
    analysis,
    presetId,
    lastState: null,
    outputFrameId: null,
    refineCount: 0,
    busy: true
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

  await runInitialLayout(runId)
}

async function runInitialLayout(runId: string): Promise<void> {
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
      `Original frame "${session.sourceName}" is no longer available.`
    )
    return
  }

  postAdaptationState(runId, 1, 'PLANNING', 'Generating layout...')

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
      `Failed to generate AI layout for frame "${session.sourceName}". ${toMessage(error)}`
    )
    return
  }

  postAdaptationState(runId, 1, 'APPLYING', 'Applying generated layout...')

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
      `Could not apply adaptation to frame "${session.sourceName}". ${toMessage(error)}`
    )
    return
  }

  const outputFrame = applyResult.frame
  session.outputFrameId = outputFrame.id
  session.refineCount = 0
  session.busy = false
  adaptationSessions.set(runId, session)

  figma.currentPage.selection = [outputFrame]
  figma.viewport.scrollAndZoomIntoView([outputFrame])

  const screenshot = await exportFrameScreenshot(outputFrame)

  const readyMessage: MainToUiMessage = {
    type: 'SESSION_READY',
    payload: {
      runId,
      createdFrameId: outputFrame.id,
      screenshot,
      metrics: applyResult.metrics,
      warnings: applyResult.warnings,
      lockedSelection: {
        nodeId: session.sourceFrameId,
        name: session.sourceName,
        width: session.sourceWidth,
        height: session.sourceHeight
      }
    }
  }
  figma.ui.postMessage(readyMessage)

  if (applyResult.warnings.length > 0) {
    figma.notify(`Initial layout applied with ${applyResult.warnings.length} warning(s).`)
  } else {
    figma.notify('Initial layout applied. Use Refine to improve.')
  }

  postAdaptationState(runId, 1, 'COMPLETED', 'Initial layout applied. Click Refine to improve.')
}

async function handleRequestRefine(payload: RequestRefinePayload): Promise<void> {
  const { runId } = payload
  const session = adaptationSessions.get(runId)
  if (typeof session === 'undefined') {
    postAdaptationError(runId, 0, 'No active session for this run.')
    return
  }

  if (session.busy) {
    figma.notify('A refinement is already in progress.')
    return
  }

  if (session.outputFrameId === null) {
    postAdaptationError(runId, 0, 'No output frame available to refine.')
    return
  }

  const outputNode = figma.getNodeById(session.outputFrameId)
  if (outputNode === null || outputNode.type !== 'FRAME') {
    adaptationSessions.delete(runId)
    postAdaptationError(runId, session.refineCount + 1, 'Output frame is no longer available.')
    return
  }

  session.busy = true
  const pass = session.refineCount + 2
  adaptationSessions.set(runId, session)

  try {
    postAdaptationState(runId, pass, 'PLANNING', `Refining layout (pass ${pass})...`)

    const refineAnalysis = await analyzeFrameForAdaptation({
      runId,
      sourceFrame: outputNode,
      targetWidth: Math.max(1, Math.round(outputNode.width)),
      targetHeight: Math.max(1, Math.round(outputNode.height)),
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

    postAdaptationState(runId, pass, 'APPLYING', `Applying refined layout (pass ${pass})...`)

    const refinedApplyResult = await applyAdaptationPlanToFrame({
      targetFrame: outputNode,
      analysis: refineAnalysis,
      plan: refinedPlan
    })

    session.refineCount += 1
    session.busy = false
    adaptationSessions.set(runId, session)

    figma.currentPage.selection = [outputNode]
    figma.viewport.scrollAndZoomIntoView([outputNode])

    const screenshot = await exportFrameScreenshot(outputNode)

    const resultMessage: MainToUiMessage = {
      type: 'APPLY_RESULT',
      payload: {
        runId,
        pass,
        createdFrameId: outputNode.id,
        screenshot,
        metrics: refinedApplyResult.metrics,
        warnings: refinedApplyResult.warnings
      }
    }
    figma.ui.postMessage(resultMessage)

    postAdaptationState(runId, pass, 'COMPLETED', 'Refinement applied. Click Refine again or start new resize.')
    figma.notify(`Refinement pass ${session.refineCount} applied.`)
  } catch (error) {
    console.error('[adaptation:refine]', error)
    session.busy = false
    adaptationSessions.set(runId, session)
    postAdaptationError(runId, pass, `Refinement failed. ${toMessage(error)}`)
    figma.notify('Refinement failed. Previous result kept.')
  }
}

function handleResetSession(payload: ResetSessionPayload): void {
  const { runId } = payload
  const session = adaptationSessions.get(runId)
  if (typeof session === 'undefined') return

  if (session.busy) {
    figma.notify('Cannot reset while a pass is running.')
    return
  }

  adaptationSessions.delete(runId)
  postSelectionState()
  figma.notify('Session cleared. Select a frame to start again.')
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
  stage: 'IDLE' | 'ANALYZING' | 'PLANNING' | 'APPLYING' | 'FINALIZING' | 'COMPLETED' | 'FAILED',
  message: string
): void {
  const session = adaptationSessions.get(runId)
  if (typeof session !== 'undefined') {
    session.lastState = {
      runId,
      pass,
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
      stage,
      message
    }
  }
  figma.ui.postMessage(stateMessage)
}

function postAdaptationError(
  runId: string,
  pass: number,
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
  postAdaptationState(runId, pass, 'FAILED', message)
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
