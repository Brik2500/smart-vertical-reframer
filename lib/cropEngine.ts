import { FaceBox, FrameDimensions, TimedFace } from './faceDetection'
import { buildStabilizedSegments, buildFFmpegExprFromSegments, type Keyframe } from './smartCropStabilizer'

export interface CropParams {
  x: number
  y: number
  width: number
  height: number
}

export interface ManualKeyframe {
  t: number
  x: number  // crop left edge in frame pixels
}

// Full source height — widest possible 9:16 crop, minimum zoom.
// Y is always 0 (full height = no vertical range to move).
function getCropDims(dims: FrameDimensions): { cropW: number; cropH: number } {
  const cropH = dims.height
  const cropW = Math.floor((cropH * 9) / 16)
  return { cropW, cropH }
}

export function computeSmartCrop(face: FaceBox | null, dims: FrameDimensions): CropParams {
  const { cropW, cropH } = getCropDims(dims)
  const centerX = face ? face.centerX : dims.width / 2
  const x = clampX(Math.floor(centerX - cropW / 2), cropW, dims.width)
  return { x, y: 0, width: cropW, height: cropH }
}

// Binary search for whether a scene cut falls within ±epsilon of timestamp t.
function makeCutLookup(sceneCuts: number[], epsilon = 0.5) {
  const sorted = [...sceneCuts].sort((a, b) => a - b)
  return (t: number): boolean => {
    let lo = 0, hi = sorted.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const diff = sorted[mid] - t
      if (Math.abs(diff) <= epsilon) return true
      if (diff < 0) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }
}

export function buildDynamicSmartCropFilter(
  timedFaces: TimedFace[],
  dims: FrameDimensions,
  manualKeyframes: ManualKeyframe[] = [],
  sceneCuts: number[] = []
): string {
  const { cropW, cropH } = getCropDims(dims)
  const edgeMarginX = Math.floor(cropW * 0.08)
  const maxX = dims.width - cropW
  const frameCenterX = Math.floor(maxX / 2)
  const sceneCutAt = makeCutLookup(sceneCuts)

  // Build raw keyframes from face detections.
  // Sort by time first — timedFaces arrive in detection order (base samples
  // interleaved with out-of-order bracket samples), not chronologically.
  // Without sorting, the timestamp and x-position dedup checks compare against
  // the wrong "previous" sample, causing both missed samples and duplicates.
  const rawKeyframes: Keyframe[] = []
  const sortedFaces = [...timedFaces].sort((a, b) => a.time - b.time)

  for (const tf of sortedFaces) {
    if (tf.detectionType === 'center') continue
    const face = tf.faces[0] ?? null
    if (!face) continue

    const rawX = Math.floor(face.centerX - cropW / 2)
    const x = Math.max(edgeMarginX, Math.min(maxX - edgeMarginX, rawX))

    if (rawKeyframes.length > 0) {
      const prev = rawKeyframes[rawKeyframes.length - 1]
      // Drop if timestamp is within 0.15s of previous (bracket landed on a base sample)
      if (Math.abs(tf.time - prev.t) < 0.15) continue
      // Drop if x hasn't moved by at least 5% of crop width (micro-jitter)
      if (Math.abs(x - prev.x) < cropW * 0.05) continue
    }

    rawKeyframes.push({ t: tf.time, x })
  }

  // Merge manual keyframes BEFORE outlier rejection with confidence: 1.0 so they
  // are never discarded as spikes — director positions are ground truth.
  for (const mk of manualKeyframes) {
    const clamped = Math.max(0, Math.min(maxX, mk.x))
    const existingIdx = rawKeyframes.findIndex(k => Math.abs(k.t - mk.t) < 1.0)
    if (existingIdx >= 0) {
      rawKeyframes[existingIdx] = { t: mk.t, x: clamped, confidence: 1.0 }
    } else {
      rawKeyframes.push({ t: mk.t, x: clamped, confidence: 1.0 })
    }
  }
  rawKeyframes.sort((a, b) => a.t - b.t)

  if (rawKeyframes.length === 0) {
    return `crop=${cropW}:${cropH}:${frameCenterX}:0,scale=540:960:flags=lanczos`
  }

  if (rawKeyframes.length === 1) {
    return `crop=${cropW}:${cropH}:${rawKeyframes[0].x}:0,scale=540:960:flags=lanczos`
  }

  console.log(`[crop] rawKF (${rawKeyframes.length}): ${rawKeyframes.map(k => `t=${k.t.toFixed(1)}x${k.x}`).join(' | ')}`)

  const segments = buildStabilizedSegments({
    rawKeyframes,
    cropWidth: cropW,
    sceneCutAt,
    sceneCuts,
  })

  console.log(`[crop] segments (${segments.length}): ${segments.map(s => `${s.fromT.toFixed(1)}-${s.toT.toFixed(1)}(${s.type}):${s.fromX}→${s.toX}`).join(' | ')}`)

  if (segments.length === 0) {
    return `crop=${cropW}:${cropH}:${frameCenterX}:0,scale=540:960:flags=lanczos`
  }

  const xExpr = buildFFmpegExprFromSegments(segments, maxX, frameCenterX)
  return `crop=${cropW}:${cropH}:'${xExpr}':0,scale=540:960:flags=lanczos`
}

function clampX(x: number, cropW: number, frameW: number): number {
  return Math.max(0, Math.min(frameW - cropW, x))
}

export function buildSmartCropFilter(crop: CropParams): string {
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=540:960:flags=lanczos`
}
