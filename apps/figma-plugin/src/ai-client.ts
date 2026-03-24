import { normalizeLlmLayoutPlan } from './adaptation-plan-schema'

import type { FrameAnalysisPayload, LlmLayoutPlan } from './adaptation-types'

type RequestDirectLayoutPlanOptions = {
  analysis: FrameAnalysisPayload
}

type RequestRefinedLayoutPlanOptions = {
  analysis: FrameAnalysisPayload
  referenceScreenshot?: FrameAnalysisPayload['screenshot']
  referenceFrameId?: string
}

type BackendScreenshot = NonNullable<FrameAnalysisPayload['screenshot']>

type UploadScreenshotRequestBody = {
  runId: string
  imageBase64: string
  contentType: 'image/png'
  filename?: string
}

type ResizeRequestBody = {
  runId: string
  input: {
    analysis: FrameAnalysisPayload
  }
}

type RefineRequestBody = {
  runId: string
  input: {
    analysis: FrameAnalysisPayload
    referenceScreenshot?: BackendScreenshot
  }
}

type LayoutRequestBody = ResizeRequestBody | RefineRequestBody

const RESIZE_ENDPOINT = 'http://localhost:3000/api/resize'
const REFINE_ENDPOINT = 'http://localhost:3000/api/refine'
const SCREENSHOT_UPLOAD_ENDPOINT = 'http://localhost:3000/api/screenshots/upload'
const REQUEST_TIMEOUT_MS = 900_000
const HEALTH_TIMEOUT_MS = 8_000
const UPLOAD_TIMEOUT_MS = 25_000
const EXPECTED_BACKEND_SERVICE_ID = 'hello-world-resize-backend'
const RESIZE_ROUTE = '/api/resize'
const REFINE_ROUTE = '/api/refine'
const verifiedRunEndpoints = new Set<string>()
const uploadedAnalysisScreenshotUrls = new Map<string, string>()

export async function requestDirectLayoutPlan(
  options: RequestDirectLayoutPlanOptions
): Promise<LlmLayoutPlan> {
  const { analysis } = options

  const analysisWithScreenshotUrl = await prepareAnalysisForBackend(analysis)

  const output = await requestResize({
    runId: analysisWithScreenshotUrl.runId,
    input: {
      analysis: analysisWithScreenshotUrl
    }
  })

  const normalized = normalizeLlmLayoutPlan(output)
  if (normalized === null) {
    throw new Error('Model response did not match layout schema.')
  }

  return normalized
}

export async function requestRefinedLayoutPlan(
  options: RequestRefinedLayoutPlanOptions
): Promise<LlmLayoutPlan> {
  const { analysis, referenceScreenshot, referenceFrameId } = options

  const analysisWithScreenshotUrl = await prepareAnalysisForBackend(analysis)

  let referenceScreenshotForBackend: BackendScreenshot | undefined
  if (referenceScreenshot !== null && typeof referenceScreenshot !== 'undefined') {
    const resolvedReferenceFrameId =
      typeof referenceFrameId === 'string' && referenceFrameId.length > 0
        ? referenceFrameId
        : 'source-reference'
    referenceScreenshotForBackend = await prepareScreenshotForBackend({
      runId: analysis.runId,
      frameId: resolvedReferenceFrameId,
      screenshot: referenceScreenshot,
      filename: `reference-${toSafeFilenameSegment(resolvedReferenceFrameId)}.png`
    })
  }

  const output = await requestRefine({
    runId: analysisWithScreenshotUrl.runId,
    input: {
      analysis: analysisWithScreenshotUrl,
      ...(typeof referenceScreenshotForBackend === 'undefined'
        ? {}
        : {
            referenceScreenshot: referenceScreenshotForBackend
          })
    }
  })

  const normalized = normalizeLlmLayoutPlan(output)
  if (normalized === null) {
    throw new Error('Model response did not match layout schema.')
  }

  return normalized
}

async function requestResize(options: ResizeRequestBody): Promise<unknown> {
  return requestLayoutPlan(options, {
    endpoint: RESIZE_ENDPOINT,
    expectedRoute: RESIZE_ROUTE,
    label: 'Resize'
  })
}

async function requestRefine(options: RefineRequestBody): Promise<unknown> {
  return requestLayoutPlan(options, {
    endpoint: REFINE_ENDPOINT,
    expectedRoute: REFINE_ROUTE,
    label: 'Refine'
  })
}

async function requestLayoutPlan(
  options: LayoutRequestBody,
  config: {
    endpoint: string
    expectedRoute: '/api/resize' | '/api/refine'
    label: 'Resize' | 'Refine'
  }
): Promise<unknown> {
  const { endpoint, expectedRoute, label } = config
  await ensureBackendReachable(options.runId, endpoint, expectedRoute, label)

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} backend request timed out after ${REQUEST_TIMEOUT_MS}ms.`))
    }, REQUEST_TIMEOUT_MS)
  })

  try {
    const response = (await Promise.race([
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(options)
      }),
      timeoutPromise
    ])) as Response

    let responseBody: unknown
    try {
      responseBody = await response.json()
    } catch (_error) {
      if (!response.ok) {
        throw new Error(`${label} backend request failed (${response.status})`)
      }
      throw new Error(`${label} backend response was not valid JSON.`)
    }

    if (isProxySuccessResponse(responseBody)) {
      return responseBody.data
    }

    if (isProxyErrorResponse(responseBody)) {
      throw new Error(`Proxy error [${responseBody.error.code}]: ${responseBody.error.message}`)
    }

    if (!response.ok) {
      throw new Error(`${label} backend request failed (${response.status})`)
    }

    throw new Error(`${label} backend response format was invalid.`)
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)
    }
  }
}

export async function prepareAnalysisForBackend(
  analysis: FrameAnalysisPayload
): Promise<FrameAnalysisPayload> {
  if (analysis.screenshot === null) {
    throw new Error(
      'Source screenshot is missing. Screenshot upload must run before adaptation. Re-run with screenshots enabled.'
    )
  }

  const screenshot = await prepareScreenshotForBackend({
    runId: analysis.runId,
    frameId: analysis.sourceFrame.nodeId,
    screenshot: analysis.screenshot,
    filename: `analysis-${toSafeFilenameSegment(analysis.sourceFrame.nodeId)}.png`
  })

  return {
    ...analysis,
    screenshot
  }
}

async function prepareScreenshotForBackend(options: {
  runId: string
  frameId: string
  screenshot: BackendScreenshot
  filename: string
}): Promise<BackendScreenshot> {
  const { runId, frameId, screenshot, filename } = options
  const cacheKey = `${runId}:${frameId}`
  const cachedUrl = uploadedAnalysisScreenshotUrls.get(cacheKey)
  if (typeof cachedUrl === 'string') {
    return {
      mimeType: 'image/png',
      url: cachedUrl
    }
  }

  if (typeof screenshot.url === 'string') {
    uploadedAnalysisScreenshotUrls.set(cacheKey, screenshot.url)
    return {
      mimeType: 'image/png',
      url: screenshot.url
    }
  }

  if (typeof screenshot.base64 !== 'string') {
    throw new Error('Screenshot base64 is missing. Cannot upload screenshot to backend.')
  }

  const uploadedUrl = await uploadScreenshotToBlob({
    runId,
    imageBase64: screenshot.base64,
    contentType: 'image/png',
    filename
  })
  uploadedAnalysisScreenshotUrls.set(cacheKey, uploadedUrl)
  return {
    mimeType: 'image/png',
    url: uploadedUrl
  }
}

async function uploadScreenshotToBlob(options: UploadScreenshotRequestBody): Promise<string> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Screenshot upload timed out after ${UPLOAD_TIMEOUT_MS}ms.`))
    }, UPLOAD_TIMEOUT_MS)
  })

  try {
    const response = (await Promise.race([
      fetch(SCREENSHOT_UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(options)
      }),
      timeoutPromise
    ])) as Response

    let responseBody: unknown
    try {
      responseBody = await response.json()
    } catch (_error) {
      throw new Error(`Screenshot upload response was not valid JSON (${response.status}).`)
    }

    if (!response.ok) {
      if (isUploadErrorResponse(responseBody)) {
        throw new Error(`${responseBody.error.code}: ${responseBody.error.message}`)
      }
      throw new Error(`Screenshot upload request failed (${response.status}).`)
    }

    if (isUploadSuccessResponse(responseBody)) {
      return responseBody.data.url
    }

    throw new Error('Screenshot upload response format was invalid.')
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)
    }
  }
}

async function ensureBackendReachable(
  runId: string,
  endpoint: string,
  expectedRoute: '/api/resize' | '/api/refine',
  label: 'Resize' | 'Refine'
): Promise<void> {
  const verifiedKey = `${runId}:${expectedRoute}`
  if (verifiedRunEndpoints.has(verifiedKey)) {
    return
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<Response>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} backend health check timed out after ${HEALTH_TIMEOUT_MS}ms.`))
    }, HEALTH_TIMEOUT_MS)
  })

  try {
    const response = (await Promise.race([
      fetch(endpoint, {
        method: 'GET'
      }),
      timeoutPromise
    ])) as Response

    let responseBody: unknown
    try {
      responseBody = await response.json()
    } catch (_error) {
      throw new Error(
        `${label} backend health check returned non-JSON response (${response.status}). ` +
          `This usually means another server is running at ${endpoint}.`
      )
    }

    if (!response.ok) {
      throw new Error(
        `${label} backend health check failed (${response.status}). ` +
          `Verify web backend is running at ${endpoint}.`
      )
    }

    if (isBackendHealthResponse(responseBody, expectedRoute) === false) {
      throw new Error(
        `Unexpected health response from ${endpoint}. ` +
          `Expected service '${EXPECTED_BACKEND_SERVICE_ID}' and route '${expectedRoute}'.`
      )
    }

    verifiedRunEndpoints.add(verifiedKey)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Cannot reach ${label.toLowerCase()} backend at ${endpoint}. ${message} ` +
        'Start the Next backend from the web/ directory and retry.'
    )
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)
    }
  }
}

function isProxySuccessResponse(
  value: unknown
): value is { ok: true; data: unknown; meta: { requestId: string; durationMs: number; model: string } } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { ok?: unknown; data?: unknown }
  return candidate.ok === true && 'data' in candidate
}

function isProxyErrorResponse(
  value: unknown
): value is { ok: false; error: { code: string; message: string }; meta: { requestId: string; durationMs: number } } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { ok?: unknown; error?: unknown }
  if (candidate.ok !== false) {
    return false
  }
  if (typeof candidate.error !== 'object' || candidate.error === null) {
    return false
  }
  const err = candidate.error as { code?: unknown; message?: unknown }
  return typeof err.code === 'string' && typeof err.message === 'string'
}

function isBackendHealthResponse(
  value: unknown,
  expectedRoute: '/api/resize' | '/api/refine'
): value is {
  ok: true
  service: string
  route: string
  timestamp: string
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as {
    ok?: unknown
    service?: unknown
    route?: unknown
    timestamp?: unknown
  }
  return (
    candidate.ok === true &&
    candidate.service === EXPECTED_BACKEND_SERVICE_ID &&
    candidate.route === expectedRoute &&
    typeof candidate.timestamp === 'string'
  )
}

function toSafeFilenameSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9-_]+/g, '_')
  return normalized.length > 0 ? normalized : 'frame'
}

function isUploadSuccessResponse(
  value: unknown
): value is {
  ok: true
  data: {
    url: string
  }
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { ok?: unknown; data?: unknown }
  if (candidate.ok !== true || typeof candidate.data !== 'object' || candidate.data === null) {
    return false
  }
  const data = candidate.data as { url?: unknown }
  return typeof data.url === 'string'
}

function isUploadErrorResponse(
  value: unknown
): value is {
  ok: false
  error: {
    code: string
    message: string
  }
} {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { ok?: unknown; error?: unknown }
  if (candidate.ok !== false || typeof candidate.error !== 'object' || candidate.error === null) {
    return false
  }
  const error = candidate.error as { code?: unknown; message?: unknown }
  return typeof error.code === 'string' && typeof error.message === 'string'
}
