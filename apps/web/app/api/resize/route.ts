import {
  APICallError,
  type JSONSchema7,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  type ModelMessage,
} from "ai";
import { NextResponse } from "next/server";

const BACKEND_SERVICE_ID = "hello-world-resize-backend";
const OVERLAP_INTERSECTION_THRESHOLD_PX2 = 1;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const SYSTEM_PROMPT = `You are a strict layout transform generator for Figma frame resizing.

Rules:
- Return only schema-compliant JSON.
- Do not output markdown.
- Be deterministic and conservative.
- Use positions and sizes relative to the target frame origin (0,0).
- Keep targetFrame width/height equal to the provided input target frame.

Process:
1. If a screenshot is provided, first build an internal visual reference from it (do not output this reference):
   - Core aesthetic and mood
   - Primary color palette and contrast pattern
   - Typography hierarchy and emphasis style
   - Signature motifs, spacing rhythm, and composition intent
2. Use that visual reference to preserve the original look-and-feel while resizing.
3. Output only the final schema-compliant JSON.

Definitions:
- Overlap means positive interior intersection area between two visible non-root node rectangles in target-frame coordinates.
- Edge touching is allowed and is not overlap.
- Intentional overlap means the node pair is listed in \`layoutHints.overlapPolicy.allowedSourceOverlapPairs\`.

Quality priorities (highest first):
1. Keep all important content readable and inside the target frame.
2. Respect intentional source-overlap pairs only.
3. Prevent all non-allowed collisions.
4. Keep the primary headline/title visually dominant while fitting cleanly.
5. Preserve text hierarchy (title > subtitle > body > caption).
6. Keep text sizing aligned with text-box scaling (downscaled text boxes must also downscale font size).
7. Preserve non-text element proportions (uniform scaling only).
8. Preserve spacing aesthetics.

Hard constraints:
- Do not apply blanket global shrink that makes the whole design look tiny.
- Do not stretch or squash icons, logos, photos, or illustrations non-uniformly.
- Keep the main title fully in frame; if space is tight, reflow spacing and secondary elements first.
- Prefer repositioning and spacing adjustments before aggressive text downscaling.
- If text must be reduced, keep headline reduction less aggressive than supporting text.
- If a text node is reduced in width or height versus source, reduce its fontSize too; do not rely on wrap-only compression.
- NEVER allow text overflow. Every text node must fit fully inside its own planned width/height (no clipping, truncation, or out-of-box rendering).
- Text-fit fallback order (strict): (1) reduce whitespace/reflow secondary content, (2) enlarge text box when collision-safe, (3) reduce fontSize, (4) compress/reposition secondary nodes, (5) keep reducing text until fit is guaranteed.
- For nodes sharing a parentPath, preserve intra-parent structure: keep local child ordering and relative offsets coherent with source intent.
- Plan grouped children in parent-local coordinates first, then convert to target-frame absolute coordinates for output.
- Do not create new overlap pairs that are not in \`allowedSourceOverlapPairs\`.
- If constraints conflict, prioritize in this order: in-frame placement + zero text overflow + collision prevention for non-allowed pairs, then hierarchy, then aesthetics.`;

const USER_PROMPT_TEMPLATE = `ROLE: Layout transform generator.
TASK: Produce full output JSON with target-frame-relative x/y/width/height and fontSize for each node.

FIRST STEP (INTERNAL, DO NOT OUTPUT):
- Build a compact visual style reference from the screenshot before resizing.
- Capture these internal notes:
  - Core aesthetic (style + mood)
  - Palette roles (background, primary accent, secondary accents, text contrast)
  - Typography hierarchy (display/headline/body/caption emphasis)
  - Distinctive motifs and compositional rhythm
- Use this reference to guide decisions in spacing, hierarchy, and emphasis during adaptation.

CONSTRAINTS:
- Use the provided source screenshot and input JSON only.
- Coordinates and dimensions are absolute pixels in target-frame space (not normalized 0..1).
- Preserve hierarchy and readability.
- Keep all important nodes inside the target frame.
- NEVER allow text overflow: each text node's rendered content must fit fully inside its own planned box.
- Overlap is allowed only when that exact pair exists in \`layoutHints.overlapPolicy.allowedSourceOverlapPairs\`.
- For pairs not listed there, intersection area must be 0 (edge touch is allowed).
- Preserve aspect ratio for non-text nodes (icons, logos, imagery, decorative marks).
- If reducing size is needed, use uniform scaling for non-text nodes.
- Keep the primary title/headline as the most prominent text while making it fit within the frame.
- Prefer reducing whitespace and reflowing secondary content before shrinking primary title text.
- If text must shrink, headline shrink should be less aggressive than body/supporting text.
- For each text node, compare source vs planned box size. If planned width or height is smaller than source, output a smaller fontSize (not equal/larger) for that node.
- Do not keep original font size in a smaller text box just to force additional wrapping.
- Preserve intra-parent relationships: for siblings sharing a parentPath, keep their relative arrangement coherent (avoid arbitrary independent drift).
- Compute child placement in parent-local terms first (using parent cluster hints), then output absolute target-frame coordinates.
- Never create a new overlap to preserve hierarchy; resolve by reflow/repositioning and secondary compression first.
- Keep each node path from input and return one node entry per non-root node.
- For non-text nodes, set fontSize to null.
- For text nodes, return a concrete fontSize that preserves hierarchy.
- Width and height must be positive numbers.

SELF-CHECK BEFORE OUTPUT:
- Main title fits and remains primary in hierarchy.
- Non-text node proportions are preserved.
- Every text node fits inside its own planned width/height with no overflow.
- Any text node with a downscaled box also has a reduced fontSize versus source text metadata when available.
- For each parentPath cluster with multiple children, relative child ordering and local offsets stay coherent with source intent.
- Layout is not globally over-shrunk.
- No unlisted overlap pairs exist.
- Any overlap that remains is intentional and listed in \`allowedSourceOverlapPairs\`.

INPUT_DATA_JSON:
{{INPUT_DATA_JSON}}`;

type ErrorCode =
  | "BAD_REQUEST"
  | "UPSTREAM_HTTP_ERROR"
  | "UPSTREAM_PAYLOAD_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "INTERNAL_ERROR";

type ResizeRequest = {
  runId: string;
  input: {
    analysis: unknown;
  };
  model?: string;
};

type RectBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OverlapPairHint = {
  pairKey: string;
  aPath: string;
  bPath: string;
  intersectionAreaPx2: number;
  zOrderHint: "aAboveB" | "bAboveA" | "unknown";
};

type ParentClusterChildHint = {
  path: string;
  zIndex: number | null;
  sourceOffsetPx: {
    x: number;
    y: number;
  };
  parentLocal: {
    left: number;
    top: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  };
};

type ParentClusterHint = {
  parentPath: string;
  childCount: number;
  childPaths: Array<string>;
  children: Array<ParentClusterChildHint>;
};

const DIRECT_LAYOUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["layoutVersion", "targetFrame", "nodes"],
  properties: {
    layoutVersion: { type: "string", const: "2" },
    targetFrame: {
      type: "object",
      additionalProperties: false,
      required: ["width", "height"],
      properties: {
        width: { type: "number", minimum: 1, maximum: 100000 },
        height: { type: "number", minimum: 1, maximum: 100000 },
      },
    },
    nodes: {
      type: "array",
      maxItems: 250,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "x", "y", "width", "height", "fontSize"],
        properties: {
          path: { type: "string", pattern: "^root(\\.\\d+)*$" },
          x: { type: "number", minimum: -100000, maximum: 100000 },
          y: { type: "number", minimum: -100000, maximum: 100000 },
          width: { type: "number", minimum: 1, maximum: 100000 },
          height: { type: "number", minimum: 1, maximum: 100000 },
          fontSize: { type: ["number", "null"], minimum: 1, maximum: 512 },
        },
      },
    },
  },
} as const;

export async function POST(request: Request) {
  const requestId = createRequestId();
  const startedAt = Date.now();

  if (
    typeof process.env.AI_GATEWAY_API_KEY !== "string" ||
    process.env.AI_GATEWAY_API_KEY.length === 0
  ) {
    return buildErrorResponse(
      requestId,
      startedAt,
      "INTERNAL_ERROR",
      "AI gateway key is not configured on backend.",
      500,
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return buildErrorResponse(
      requestId,
      startedAt,
      "BAD_REQUEST",
      "Request body must be valid JSON.",
      400,
    );
  }

  const parsedRequest = parseResizeRequest(rawBody);
  if (parsedRequest === null) {
    return buildErrorResponse(
      requestId,
      startedAt,
      "BAD_REQUEST",
      "Invalid resize request payload.",
      400,
    );
  }

  const screenshotImage = tryGetScreenshotImage(parsedRequest.input.analysis);
  if (screenshotImage === null) {
    return buildErrorResponse(
      requestId,
      startedAt,
      "BAD_REQUEST",
      "Resize request must include a screenshot image in input.analysis.screenshot (url or mimeType+base64).",
      400,
    );
  }

  try {
    const dataset = toCompactNodeDataset(parsedRequest.input.analysis);
    const userPrompt = USER_PROMPT_TEMPLATE.replaceAll("{{INPUT_DATA_JSON}}", dataset);

    const messages: Array<ModelMessage> = [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image", image: screenshotImage },
        ],
      },
    ];

    const result = await generateText({
      model: "openai/gpt-5.3-codex",
      providerOptions: {
        openai: {
          reasoningEffort: "medium",
        },
      },
      messages,
      output: Output.object({
        schema: jsonSchema(DIRECT_LAYOUT_SCHEMA as unknown as JSONSchema7),
        name: "direct_layout",
      }),
      timeout: { totalMs: 900000 },
    });

    const payload = {
      ok: true,
      data: result.output,
      meta: {
        requestId,
        model: "openai/gpt-5.3-codex",
        durationMs: Date.now() - startedAt,
      },
    };

    console.info(
      `[api/resize] requestId=${requestId} runId=${parsedRequest.runId} status=200`,
      JSON.stringify(payload),
    );

    return withCors(NextResponse.json(payload, { status: 200 }));
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      return buildErrorResponse(
        requestId,
        startedAt,
        "UPSTREAM_PAYLOAD_ERROR",
        "Model response did not match resize schema.",
        502,
      );
    }

    if (error instanceof APICallError) {
      if (/timed out/i.test(error.message)) {
        return buildErrorResponse(
          requestId,
          startedAt,
          "UPSTREAM_TIMEOUT",
          `Model request timed out after 900s.`,
          504,
        );
      }

      return buildErrorResponse(
        requestId,
        startedAt,
        "UPSTREAM_HTTP_ERROR",
        error.message,
        502,
        error.statusCode,
      );
    }

    const message = error instanceof Error ? error.message : "Unknown resize backend error.";
    return buildErrorResponse(requestId, startedAt, "INTERNAL_ERROR", message, 500);
  }
}

export async function OPTIONS() {
  return withCors(new NextResponse(null, { status: 204 }));
}

export async function GET() {
  return withCors(
    NextResponse.json(
      {
        ok: true,
        service: BACKEND_SERVICE_ID,
        route: "/api/resize",
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    ),
  );
}

function withCors(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

function buildErrorResponse(
  requestId: string,
  startedAt: number,
  code: ErrorCode,
  message: string,
  status: number,
  upstreamStatus?: number,
) {
  const payload = {
    ok: false,
    error: {
      code,
      message,
      ...(typeof upstreamStatus === "number" ? { upstreamStatus } : {}),
    },
    meta: {
      requestId,
      durationMs: Date.now() - startedAt,
    },
  };

  console.error(
    `[api/resize] requestId=${requestId} status=${status} code=${code}`,
    JSON.stringify(payload),
  );

  return withCors(NextResponse.json(payload, { status }));
}

function createRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseResizeRequest(value: unknown): ResizeRequest | null {
  if (!isRecord(value) || !hasString(value.runId) || !isRecord(value.input)) {
    return null;
  }

  const model = typeof value.model === "string" ? value.model : undefined;
  if (!isAnalysisLike(value.input.analysis)) {
    return null;
  }

  return {
    runId: value.runId,
    input: {
      analysis: value.input.analysis,
    },
    model,
  };
}

function isAnalysisLike(value: unknown): value is {
  sourceFrame: unknown;
  targetFrame: unknown;
  nodes: Array<unknown>;
} {
  if (!isRecord(value)) {
    return false;
  }
  return isRecord(value.sourceFrame) && isRecord(value.targetFrame) && Array.isArray(value.nodes);
}

function tryGetScreenshotImage(analysis: unknown): string | null {
  if (!isRecord(analysis) || !isRecord(analysis.screenshot)) {
    return null;
  }

  const screenshot = analysis.screenshot;
  if (typeof screenshot.url === "string" && screenshot.url.trim().length > 0) {
    return screenshot.url;
  }

  if (typeof screenshot.mimeType !== "string" || typeof screenshot.base64 !== "string") {
    return null;
  }

  if (screenshot.mimeType.trim().length === 0 || screenshot.base64.trim().length === 0) {
    return null;
  }

  return `data:${screenshot.mimeType};base64,${screenshot.base64}`;
}

function toCompactNodeDataset(analysis: unknown): string {
  if (!isRecord(analysis)) {
    return "{}";
  }

  const sourceFrame = analysis.sourceFrame;
  const targetFrame = analysis.targetFrame;
  const rawNodes = analysis.nodes;

  const compactNodes = Array.isArray(rawNodes)
    ? rawNodes.map((rawNode) => {
        if (!isRecord(rawNode)) {
          return {};
        }

        return {
          path: rawNode.path,
          parentPath: rawNode.parentPath,
          name: rawNode.name,
          type: rawNode.type,
          classification: rawNode.classification,
          absolute: rawNode.absolute,
          normalized: rawNode.normalized,
          textMeta: rawNode.textMeta,
          isVisible: rawNode.isVisible,
          zIndex: rawNode.zIndex,
          aspectRatio: getAspectRatio(rawNode.absolute),
        };
      })
    : [];

  const nodesForHints = compactNodes.filter((node): node is Record<string, unknown> => {
    return isRecord(node);
  });

  const scaleHints = toScaleHints(sourceFrame, targetFrame);
  const titleCandidatePaths = getTitleCandidatePaths(nodesForHints);
  const allowedSourceOverlapPairs = buildAllowedSourceOverlapPairs(nodesForHints);
  const parentClusterHints = buildParentClusterHints(nodesForHints);

  return JSON.stringify({
    sourceFrame,
    targetFrame,
    layoutHints: {
      sourceToTargetScale: scaleHints,
      titleCandidatePaths,
      primaryTitlePath: titleCandidatePaths[0] ?? null,
      preserveUniformScaleForNonText: true,
      keepPrimaryTitleDominant: true,
      overlapPolicy: {
        definition: {
          coordinateSpace: "target-frame-relative",
          overlapIntersectionAreaPx2Threshold: OVERLAP_INTERSECTION_THRESHOLD_PX2,
          edgeTouchingCountsAsOverlap: false,
        },
        allowOnlySourcePairs: true,
        preventNewOverlaps: true,
        tieBreakerOrder: [
          "inFrameReadability",
          "respectAllowedSourceOverlaps",
          "preventNonAllowedCollisions",
          "preserveTitleDominance",
          "preserveAestheticSpacing",
        ],
        allowedSourceOverlapPairs,
      },
      parentClusterHints,
      visualReferenceFirstPass: {
        enabled: tryGetScreenshotImage(analysis) !== null,
        sections: ["coreAesthetic", "colorPalette", "typographySystem", "keyDesignElements"],
      },
    },
    nodes: compactNodes,
  });
}

function buildAllowedSourceOverlapPairs(nodes: Array<Record<string, unknown>>): Array<OverlapPairHint> {
  const positionedNodes = nodes
    .map((node) => {
      if (typeof node.path !== "string" || node.path.length === 0 || node.path === "root") {
        return null;
      }

      if (node.isVisible === false) {
        return null;
      }

      const rect = toAbsoluteRect(node.absolute);
      if (rect === null) {
        return null;
      }

      return {
        path: node.path,
        rect,
        zIndex: asFiniteNumber(node.zIndex),
      };
    })
    .filter(
      (
        item,
      ): item is {
        path: string;
        rect: RectBounds;
        zIndex: number | null;
      } => item !== null,
    );

  const overlaps: Array<OverlapPairHint> = [];

  for (let indexA = 0; indexA < positionedNodes.length; indexA += 1) {
    for (let indexB = indexA + 1; indexB < positionedNodes.length; indexB += 1) {
      const nodeA = positionedNodes[indexA];
      const nodeB = positionedNodes[indexB];
      const area = getIntersectionArea(nodeA.rect, nodeB.rect);
      if (area <= OVERLAP_INTERSECTION_THRESHOLD_PX2) {
        continue;
      }

      const pairIsSorted = nodeA.path < nodeB.path;
      overlaps.push({
        pairKey: toStablePairKey(nodeA.path, nodeB.path),
        aPath: pairIsSorted ? nodeA.path : nodeB.path,
        bPath: pairIsSorted ? nodeB.path : nodeA.path,
        intersectionAreaPx2: toRounded(area, 2),
        zOrderHint: pairIsSorted
          ? toZOrderHint(nodeA.zIndex, nodeB.zIndex)
          : toZOrderHint(nodeB.zIndex, nodeA.zIndex),
      });
    }
  }

  overlaps.sort((a, b) => a.pairKey.localeCompare(b.pairKey));
  return overlaps;
}

function buildParentClusterHints(nodes: Array<Record<string, unknown>>): Array<ParentClusterHint> {
  const rectByPath = new Map<string, RectBounds>();

  for (const node of nodes) {
    if (typeof node.path !== "string" || node.path.length === 0) {
      continue;
    }

    const rect = toAbsoluteRect(node.absolute);
    if (rect === null) {
      continue;
    }

    rectByPath.set(node.path, rect);
  }

  const clusters = new Map<string, Array<ParentClusterChildHint>>();

  for (const node of nodes) {
    if (node.isVisible === false) {
      continue;
    }

    if (typeof node.path !== "string" || node.path === "root") {
      continue;
    }

    if (typeof node.parentPath !== "string" || node.parentPath.length === 0) {
      continue;
    }

    const childRect = rectByPath.get(node.path);
    const parentRect = rectByPath.get(node.parentPath);

    if (typeof childRect === "undefined" || typeof parentRect === "undefined") {
      continue;
    }

    if (parentRect.width <= 0 || parentRect.height <= 0) {
      continue;
    }

    const childHints = clusters.get(node.parentPath) ?? [];
    childHints.push({
      path: node.path,
      zIndex: asFiniteNumber(node.zIndex),
      sourceOffsetPx: {
        x: toRounded(childRect.x - parentRect.x, 2),
        y: toRounded(childRect.y - parentRect.y, 2),
      },
      parentLocal: {
        left: toRounded((childRect.x - parentRect.x) / parentRect.width, 4),
        top: toRounded((childRect.y - parentRect.y) / parentRect.height, 4),
        width: toRounded(childRect.width / parentRect.width, 4),
        height: toRounded(childRect.height / parentRect.height, 4),
        centerX: toRounded((childRect.x + childRect.width / 2 - parentRect.x) / parentRect.width, 4),
        centerY: toRounded((childRect.y + childRect.height / 2 - parentRect.y) / parentRect.height, 4),
      },
    });
    clusters.set(node.parentPath, childHints);
  }

  const clusterHints: Array<ParentClusterHint> = [];

  for (const [parentPath, children] of clusters.entries()) {
    if (children.length < 2) {
      continue;
    }

    children.sort((a, b) => {
      if (a.zIndex !== null && b.zIndex !== null && a.zIndex !== b.zIndex) {
        return a.zIndex - b.zIndex;
      }
      return a.path.localeCompare(b.path);
    });

    clusterHints.push({
      parentPath,
      childCount: children.length,
      childPaths: children.map((child) => child.path),
      children,
    });
  }

  clusterHints.sort((a, b) => a.parentPath.localeCompare(b.parentPath));
  return clusterHints;
}

function getTitleCandidatePaths(nodes: Array<Record<string, unknown>>): Array<string> {
  const candidates = nodes
    .map((node) => {
      if (node.classification !== "TEXT" || typeof node.path !== "string") {
        return null;
      }

      const textMeta = (node.textMeta ?? null) as {
        maxFontSize?: unknown;
        avgFontSize?: unknown;
      } | null;

      const normalized = (node.normalized ?? null) as {
        top?: unknown;
        width?: unknown;
        height?: unknown;
      } | null;

      const fontScore =
        asFiniteNumber(textMeta?.maxFontSize) ?? asFiniteNumber(textMeta?.avgFontSize) ?? 0;
      const top = asFiniteNumber(normalized?.top) ?? 0.5;
      const width = asFiniteNumber(normalized?.width) ?? 0;
      const height = asFiniteNumber(normalized?.height) ?? 0;
      const area = width * height;

      return {
        path: node.path,
        score: fontScore * 10 + area * 5 - top * 2,
      };
    })
    .filter((item): item is { path: string; score: number } => item !== null)
    .sort((a, b) => b.score - a.score);

  return candidates.slice(0, 3).map((item) => item.path);
}

function toScaleHints(
  sourceFrame: unknown,
  targetFrame: unknown,
): { x: number | null; y: number | null; uniformMin: number | null; uniformMax: number | null } {
  const sourceWidth = asFiniteNumber((sourceFrame as { width?: unknown } | undefined)?.width);
  const sourceHeight = asFiniteNumber((sourceFrame as { height?: unknown } | undefined)?.height);
  const targetWidth = asFiniteNumber((targetFrame as { width?: unknown } | undefined)?.width);
  const targetHeight = asFiniteNumber((targetFrame as { height?: unknown } | undefined)?.height);

  if (
    sourceWidth === null ||
    sourceHeight === null ||
    targetWidth === null ||
    targetHeight === null ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return {
      x: null,
      y: null,
      uniformMin: null,
      uniformMax: null,
    };
  }

  const x = targetWidth / sourceWidth;
  const y = targetHeight / sourceHeight;

  return {
    x: toRounded(x),
    y: toRounded(y),
    uniformMin: toRounded(Math.min(x, y)),
    uniformMax: toRounded(Math.max(x, y)),
  };
}

function getAspectRatio(rect: unknown): number | null {
  if (!isRecord(rect)) {
    return null;
  }

  const width = asFiniteNumber(rect.width);
  const height = asFiniteNumber(rect.height);
  if (width === null || height === null || height <= 0) {
    return null;
  }

  return toRounded(width / height);
}

function toAbsoluteRect(value: unknown): RectBounds | null {
  if (!isRecord(value)) {
    return null;
  }

  const x = asFiniteNumber(value.x);
  const y = asFiniteNumber(value.y);
  const width = asFiniteNumber(value.width);
  const height = asFiniteNumber(value.height);

  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }

  return { x, y, width, height };
}

function getIntersectionArea(a: RectBounds, b: RectBounds): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  const width = right - left;
  const height = bottom - top;

  if (width <= 0 || height <= 0) {
    return 0;
  }

  return width * height;
}

function toStablePairKey(pathA: string, pathB: string): string {
  return pathA < pathB ? `${pathA}||${pathB}` : `${pathB}||${pathA}`;
}

function toZOrderHint(aZ: number | null, bZ: number | null): OverlapPairHint["zOrderHint"] {
  if (aZ === null || bZ === null || aZ === bZ) {
    return "unknown";
  }
  return aZ > bZ ? "aAboveB" : "bAboveA";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return null;
  }
  return value;
}

function toRounded(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
