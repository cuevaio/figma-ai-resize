import type { LlmLayoutPlan, LlmNodePlan } from './adaptation-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeNodePlan(value: unknown, targetWidth: number, targetHeight: number): LlmNodePlan | null {
  if (!isRecord(value)) {
    return null
  }

  const path = value.path
  const x = value.x
  const y = value.y
  const width = value.width
  const height = value.height
  const fontSize = value.fontSize

  if (typeof path !== 'string' || path.length === 0) {
    return null
  }

  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null
  }

  if (fontSize !== null && typeof fontSize !== 'undefined' && !isFiniteNumber(fontSize)) {
    return null
  }

  return {
    path,
    x: clamp(Math.round(x), -targetWidth * 2, targetWidth * 2),
    y: clamp(Math.round(y), -targetHeight * 2, targetHeight * 2),
    width: clamp(Math.round(width), 1, targetWidth * 3),
    height: clamp(Math.round(height), 1, targetHeight * 3),
    fontSize: typeof fontSize === 'number' ? clamp(Math.round(fontSize), 1, 512) : null
  }
}

export function normalizeLlmLayoutPlan(value: unknown): LlmLayoutPlan | null {
  if (!isRecord(value)) {
    return null
  }

  if (value.layoutVersion !== '2') {
    return null
  }

  if (!isRecord(value.targetFrame)) {
    return null
  }

  const targetWidth = value.targetFrame.width
  const targetHeight = value.targetFrame.height
  if (!isFiniteNumber(targetWidth) || !isFiniteNumber(targetHeight)) {
    return null
  }

  if (Array.isArray(value.nodes) === false) {
    return null
  }

  if (value.nodes.length === 0) {
    return null
  }

  const normalizedNodes: Array<LlmNodePlan> = []
  const seenPaths = new Set<string>()

  for (const item of value.nodes) {
    const normalized = normalizeNodePlan(item, targetWidth, targetHeight)
    if (normalized === null) {
      return null
    }

    if (seenPaths.has(normalized.path)) {
      return null
    }

    seenPaths.add(normalized.path)
    normalizedNodes.push(normalized)
  }

  return {
    layoutVersion: '2',
    targetFrame: {
      width: Math.max(1, Math.round(targetWidth)),
      height: Math.max(1, Math.round(targetHeight))
    },
    nodes: normalizedNodes
  }
}

export const LLM_LAYOUT_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['layoutVersion', 'targetFrame', 'nodes'],
  properties: {
    layoutVersion: { type: 'string', const: '2' },
    targetFrame: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'number', minimum: 1, maximum: 100000 },
        height: { type: 'number', minimum: 1, maximum: 100000 }
      }
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'x', 'y', 'width', 'height', 'fontSize'],
        properties: {
          path: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number', minimum: 1 },
          height: { type: 'number', minimum: 1 },
          fontSize: { type: ['number', 'null'], minimum: 1, maximum: 512 }
        }
      }
    }
  }
} as const
