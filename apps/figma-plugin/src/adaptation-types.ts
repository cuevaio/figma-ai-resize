export type AdaptationStage =
  | 'IDLE'
  | 'ANALYZING'
  | 'PLANNING'
  | 'APPLYING'
  | 'FINALIZING'
  | 'COMPLETED'
  | 'FAILED'

export type NodeClassification =
  | 'BACKGROUND'
  | 'TEXT'
  | 'ICON'
  | 'LOGO'
  | 'RAIL'
  | 'MENU'
  | 'CONTENT'
  | 'DECORATION'

export type BoundingRect = {
  x: number
  y: number
  width: number
  height: number
}

export type NormalizedRect = {
  left: number
  top: number
  width: number
  height: number
  centerX: number
  centerY: number
}

export type FrameNodeAnalysis = {
  path: string
  nodeId: string
  name: string
  type: string
  parentPath: string | null
  zIndex: number
  isVisible: boolean
  classification: NodeClassification
  absolute: BoundingRect
  normalized: NormalizedRect
  textMeta?: {
    characters: number
    estimatedLines: number
    textAutoResize: string
    minFontSize: number
    maxFontSize: number
    avgFontSize: number
  }
}

export type FrameAnalysisPayload = {
  runId: string
  sourceFrame: {
    nodeId: string
    name: string
    width: number
    height: number
  }
  targetFrame: {
    width: number
    height: number
    presetId: string
  }
  nodes: Array<FrameNodeAnalysis>
  screenshot:
    | {
        mimeType: 'image/png'
        base64?: string
        url?: string
      }
    | null
}

export type LlmNodePlan = {
  path: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number | null
}

export type LlmLayoutPlan = {
  layoutVersion: '2'
  targetFrame: {
    width: number
    height: number
  }
  nodes: Array<LlmNodePlan>
}

export type AdaptationWarningCode =
  | 'NODE_MISSING'
  | 'NODE_APPLY_FAILED'
  | 'FONT_LOAD_FAILED'

export type AdaptationMetrics = {
  textWrapRisk: number
  textHierarchyRisk: number
  anchorDriftRisk: number
  iconDistortionRisk: number
  railIntegrityRisk: number
  overallRisk: number
}

export type AdaptationWarning = {
  code: AdaptationWarningCode
  message: string
  path?: string
}
