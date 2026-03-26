import type {
  AdaptationStage,
  AdaptationMetrics,
  AdaptationWarning,
  FrameAnalysisPayload
} from './adaptation-types'

export type PresetId = '1:1' | '4:3' | '3:4' | '16:9' | '9:16' | '3:2' | '2:3'

export type InvalidSelectionReason = 'NO_SELECTION' | 'MULTI_SELECTION' | 'NOT_FRAME'

export type AspectRatioPreset = {
  id: PresetId
  width: number
  height: number
}

export const ASPECT_RATIO_PRESETS: Array<AspectRatioPreset> = [
  { id: '1:1', width: 1, height: 1 },
  { id: '4:3', width: 4, height: 3 },
  { id: '3:4', width: 3, height: 4 },
  { id: '16:9', width: 16, height: 9 },
  { id: '9:16', width: 9, height: 16 },
  { id: '3:2', width: 3, height: 2 },
  { id: '2:3', width: 2, height: 3 }
]

export const DEFAULT_PRESET_ID: PresetId = '1:1'

export type SelectionInfo = {
  nodeId: string
  name: string
  width: number
  height: number
}

export type InitSelectionStatePayload =
  | {
      valid: true
      selection: SelectionInfo
      presets: Array<AspectRatioPreset>
      defaultPresetId: PresetId
    }
  | {
      valid: false
      reason: InvalidSelectionReason
      presets: Array<AspectRatioPreset>
      defaultPresetId: PresetId
    }

export type StartAdaptationPayload = {
  runId: string
  presetId: PresetId
  includeScreenshot: boolean
}

export type RequestRefinePayload = {
  runId: string
}

export type ResetSessionPayload = {
  runId: string
}

export type AdaptationStatePayload = {
  runId: string
  pass: number
  stage: AdaptationStage
  message: string
}

export type SessionReadyPayload = {
  runId: string
  createdFrameId: string
  screenshot:
    | {
        mimeType: 'image/png'
        base64: string
      }
    | null
  metrics: AdaptationMetrics
  warnings: Array<AdaptationWarning>
  lockedSelection: SelectionInfo
}

export type AdaptationRehydratePayload = {
  activeRun: AdaptationStatePayload | null
  session: {
    runId: string
    lockedSelection: SelectionInfo
    refineCount: number
    createdFrameId: string
  } | null
}

export type AnalysisReadyPayload = {
  runId: string
  analysis: FrameAnalysisPayload
}

export type ApplyResultPayload = {
  runId: string
  pass: number
  createdFrameId: string
  screenshot:
    | {
        mimeType: 'image/png'
        base64: string
      }
    | null
  metrics: AdaptationMetrics
  warnings: Array<AdaptationWarning>
}

export type AdaptationErrorPayload = {
  runId: string
  message: string
}

export type UiToMainMessage =
  | { type: 'START_ADAPTATION'; payload: StartAdaptationPayload }
  | { type: 'REQUEST_REFINE'; payload: RequestRefinePayload }
  | { type: 'RESET_SESSION'; payload: ResetSessionPayload }
  | { type: 'REQUEST_ADAPTATION_REHYDRATE' }

export type MainToUiMessage =
  | {
      type: 'SELECTION_STATE'
      payload: InitSelectionStatePayload
    }
  | {
      type: 'ADAPTATION_STATE'
      payload: AdaptationStatePayload
    }
  | {
      type: 'ANALYSIS_READY'
      payload: AnalysisReadyPayload
    }
  | {
      type: 'SESSION_READY'
      payload: SessionReadyPayload
    }
  | {
      type: 'APPLY_RESULT'
      payload: ApplyResultPayload
    }
  | {
      type: 'ADAPTATION_ERROR'
      payload: AdaptationErrorPayload
    }
  | {
      type: 'ADAPTATION_REHYDRATE'
      payload: AdaptationRehydratePayload
    }
