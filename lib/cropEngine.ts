import { FaceBox, FrameDimensions, TimedFace } from './faceDetection'

export interface CropParams {
  x: number
  y: number
  width: number
  height: number
}

// Full source height — widest possible 9:16 crop, minimum zoom.
// This preserves shoulders and environmental context rather than filling the frame with face.
// Y is always 0 (full height = no vertical range to move), which is fine:
// the cinematographer's original vertical framing is preserved.
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

interface Keyframe {
  t: number
  x: number
  y: number
}

export function buildDynamicSmartCropFilter(
  timedFaces: TimedFace[],
  dims: FrameDimensions
): string {
  const { cropW, cropH } = getCropDims(dims)
  const edgeMarginX = Math.floor(cropW * 0.08)
  const maxX = dims.width - cropW
  const maxY = dims.height - cropH

  const keyframes: Keyframe[] = []

  for (const tf of timedFaces) {
    const face = tf.faces[0] ?? null
    if (!face) continue

    const rawX = Math.floor(face.centerX - cropW / 2)
    const x = Math.max(edgeMarginX, Math.min(maxX - edgeMarginX, rawX))
    const y = 0  // full height crop — Y is always 0, preserving original vertical framing

    // Skip if this keyframe is too close to the previous one with only minor movement
    // (Rule 5: don't re-compose on every sample — stabilize)
    if (keyframes.length > 0) {
      const prev = keyframes[keyframes.length - 1]
      const dx = Math.abs(x - prev.x)
      const minMove = cropW * 0.05
      if (dx < minMove) continue
    }

    keyframes.push({ t: tf.time, x, y })
  }

  if (keyframes.length === 0) {
    const x = Math.floor((dims.width - cropW) / 2)
    return `crop=${cropW}:${cropH}:${x}:0,scale=1080:1920:flags=lanczos`
  }

  if (keyframes.length === 1) {
    return `crop=${cropW}:${cropH}:${keyframes[0].x}:${keyframes[0].y},scale=1080:1920:flags=lanczos`
  }

  const xExpr = buildMotionExpression(keyframes, 'x', maxX, dims.width)

  // Y is always 0 — full height crop preserves original vertical framing
  return `crop=${cropW}:${cropH}:'${xExpr}':0,scale=1080:1920:flags=lanczos`
}

// Determines whether to snap (cut) or ease (pan) between keyframes.
// Large X jumps are camera cuts — hold the previous position rather than
// panning through dead space. Small/medium movements are pans — ease them.
function buildMotionExpression(
  keyframes: Keyframe[],
  axis: 'x' | 'y',
  maxVal: number,
  frameSize: number
): string {
  const CUT_THRESHOLD = frameSize * 0.30  // 30% of frame width = likely a cut, not a pan
  const TIME_GAP_THRESHOLD = 5            // seconds — long gap means a cutaway happened

  let expr = String(keyframes[keyframes.length - 1][axis])

  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k0 = keyframes[i]
    const k1 = keyframes[i + 1]
    const v0 = k0[axis]
    const v1 = k1[axis]
    const dt = k1.t - k0.t
    const dv = Math.abs(v1 - v0)
    if (dt <= 0) continue

    let segExpr: string

    if (dv > CUT_THRESHOLD || dt > TIME_GAP_THRESHOLD) {
      // Cut or long gap: hold current position through the gap, snap to next at k1.t.
      // Long time gaps (>5s between valid face detections) mean a cutaway happened —
      // interpolating through that gap would pan the crop across empty space.
      segExpr = String(v0)
    } else {
      // Pan: ease-in-out interpolation (smoothstep) for natural camera movement
      // smoothstep: 3t² - 2t³ where t = normalized time in segment
      const norm = `((t-${k0.t})/${dt.toFixed(4)})`
      const smooth = `(${norm}*${norm}*(3.0-2.0*${norm}))`
      const eased = `(${v0}+(${v1 - v0})*${smooth})`
      segExpr = `max(0,min(${maxVal},${eased}))`
    }

    expr = `if(between(t,${k0.t},${k1.t}),${segExpr},${expr})`
  }

  // Before first detected face: ease in from center frame to first known position.
  // This prevents the crop from being pre-positioned for a subject that hasn't
  // appeared yet while a different subject is visible at the start.
  const centerVal = Math.floor(maxVal / 2)
  const preRoll = keyframes[0].t
  const v0 = keyframes[0][axis]
  const preLerp = preRoll > 0
    ? `(${centerVal}+(${v0 - centerVal})*(t/${preRoll.toFixed(4)}))`
    : String(v0)
  expr = `if(lt(t,${preRoll}),max(0,min(${maxVal},${preLerp})),${expr})`
  return expr
}

function clampX(x: number, cropW: number, frameW: number): number {
  return Math.max(0, Math.min(frameW - cropW, x))
}

function clampY(y: number, cropH: number, frameH: number): number {
  return Math.max(0, Math.min(frameH - cropH, y))
}

export function buildSmartCropFilter(crop: CropParams): string {
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=1080:1920:flags=lanczos`
}
