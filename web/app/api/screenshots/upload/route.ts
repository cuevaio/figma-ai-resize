import { put } from '@vercel/blob'
import { NextResponse } from 'next/server'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
}

type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR'

type UploadRequest = {
  runId: string
  imageBase64: string
  contentType: 'image/png'
  filename?: string
}

function withCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value)
  }
  return response
}

function createRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function buildErrorResponse(
  requestId: string,
  startedAt: number,
  code: ErrorCode,
  message: string,
  status: number
): NextResponse {
  return withCors(
    NextResponse.json(
      {
        ok: false,
        error: {
          code,
          message
        },
        meta: {
          requestId,
          durationMs: Date.now() - startedAt
        }
      },
      { status }
    )
  )
}

function parseUploadRequest(value: unknown): UploadRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const candidate = value as {
    runId?: unknown
    imageBase64?: unknown
    contentType?: unknown
    filename?: unknown
  }

  if (
    typeof candidate.runId !== 'string' ||
    candidate.runId.length === 0 ||
    typeof candidate.imageBase64 !== 'string' ||
    candidate.imageBase64.length === 0 ||
    candidate.contentType !== 'image/png'
  ) {
    return null
  }

  return {
    runId: candidate.runId,
    imageBase64: candidate.imageBase64,
    contentType: 'image/png',
    filename: typeof candidate.filename === 'string' ? candidate.filename : undefined
  }
}

function safeFilename(filename: string | undefined): string {
  if (typeof filename !== 'string' || filename.length === 0) {
    return 'screenshot'
  }

  const normalized = filename
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (normalized.length === 0) {
    return 'screenshot'
  }

  return normalized
}

function decodeBase64Image(imageBase64: string): Buffer | null {
  try {
    const binary = atob(imageBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return Buffer.from(bytes)
  } catch (_error) {
    return null
  }
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }))
}

export async function POST(request: Request) {
  const requestId = createRequestId()
  const startedAt = Date.now()

  if (
    typeof process.env.BLOB_READ_WRITE_TOKEN !== 'string' ||
    process.env.BLOB_READ_WRITE_TOKEN.length === 0
  ) {
    return buildErrorResponse(
      requestId,
      startedAt,
      'INTERNAL_ERROR',
      'Blob token is not configured on backend.',
      500
    )
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch (_error) {
    return buildErrorResponse(requestId, startedAt, 'BAD_REQUEST', 'Request body must be valid JSON.', 400)
  }

  const payload = parseUploadRequest(rawBody)
  if (payload === null) {
    return buildErrorResponse(
      requestId,
      startedAt,
      'BAD_REQUEST',
      'Invalid upload payload. Expected runId, imageBase64, contentType=image/png.',
      400
    )
  }

  if (payload.contentType !== 'image/png') {
    return buildErrorResponse(
      requestId,
      startedAt,
      'UNSUPPORTED_MEDIA_TYPE',
      'Only image/png is supported.',
      415
    )
  }

  const bytes = decodeBase64Image(payload.imageBase64)
  if (bytes === null) {
    return buildErrorResponse(requestId, startedAt, 'BAD_REQUEST', 'imageBase64 is not valid base64.', 400)
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return buildErrorResponse(
      requestId,
      startedAt,
      'PAYLOAD_TOO_LARGE',
      `Image exceeds max size of ${MAX_IMAGE_BYTES} bytes.`,
      413
    )
  }

  const fileBase = safeFilename(payload.filename)
  const pathname = `screenshots/${payload.runId}/${Date.now()}-${fileBase}.png`

  try {
    const blob = await put(pathname, bytes, {
      access: 'public',
      contentType: payload.contentType,
      addRandomSuffix: false
    })

    return withCors(
      NextResponse.json(
        {
          ok: true,
          data: {
            url: blob.url,
            sizeBytes: bytes.byteLength,
            contentType: payload.contentType,
            pathname
          },
          meta: {
            requestId,
            durationMs: Date.now() - startedAt
          }
        },
        { status: 200 }
      )
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown upload error.'
    return buildErrorResponse(requestId, startedAt, 'INTERNAL_ERROR', message, 500)
  }
}
