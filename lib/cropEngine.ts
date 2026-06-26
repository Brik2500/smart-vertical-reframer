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

export interface ManualKeyframe {
  t: number
  x: number  // crop left edge in frame pixels
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

  const keyframes: Keyframe[] = []

  for (const tf of timedFaces) {
    // 'center' is a pure no-detection fallback — it has no subject information
    // and would pull the crop toward the middle for stretches with no face/object.
    // Skipping it lets the expression hold the last known-good position instead.
    if (tf.detectionType === 'center') continue

    const face = tf.faces[0] ?? null
    if (!face) continue

    const rawX = Math.floor(face.centerX - cropW / 2)
    const x = Math.max(edgeMarginX, Math.min(maxX - edgeMarginX, rawX))

    if (keyframes.length > 0) {
      const prev = keyframes[keyframes.length - 1]
      const dx = Math.abs(x - prev.x)
      const minMove = cropW * 0.05
      if (dx < minMove) continue
    }

    keyframes.push({ t: tf.time, x, y: 0 })
  }

  // Merge manual keyframes — director overrides take precedence
  for (const mk of manualKeyframes) {
    const clamped = Math.max(0, Math.min(maxX, mk.x))
    const idx = keyframes.findIndex(k => Math.abs(k.t - mk.t) < 1.0)
    if (idx >= 0) {
      keyframes[idx].x = clamped
    } else {
      keyframes.push({ t: mk.t, x: clamped, y: 0 })
    }
  }
  keyframes.sort((a, b) => a.t - b.t)

  // Outlier rejection using linear interpolation:
  // Compare each keyframe's x against where it *should* be if the neighbors
  // represent a continuous smooth move (time-weighted, not a simple average).
  // A big deviation is only accepted if a scene cut independently corroborates it.
  const OUTLIER_THRESHOLD = dims.width * 0.25
  const cleaned = keyframes.filter((k, i) => {
    if (i === 0 || i === keyframes.length - 1) return true
    const nearCut = sceneCuts.some(c => Math.abs(c - k.t) < 1.5)
    if (nearCut) return true
    const prev = keyframes[i - 1]
    const next = keyframes[i + 1]
    const dtTotal = next.t - prev.t
    const expectedX = dtTotal > 0
      ? prev.x + (next.x - prev.x) * ((k.t - prev.t) / dtTotal)
      : (prev.x + next.x) / 2
    return Math.abs(k.x - expectedX) <= OUTLIER_THRESHOLD
  })

  if (cleaned.length === 0) {
    const x = Math.floor((dims.width - cropW) / 2)
    return `crop=${cropW}:${cropH}:${x}:0,scale=540:960:flags=lanczos`
  }

  if (cleaned.length === 1) {
    return `crop=${cropW}:${cropH}:${cleaned[0].x}:${cleaned[0].y},scale=540:960:flags=lanczos`
  }

  const xExpr = buildMotionExpression(cleaned, 'x', maxX, dims.width, sceneCuts)
  return `crop=${cropW}:${cropH}:'${xExpr}':0,scale=540:960:flags=lanczos`
}

// Determines whether to snap (cut) or ease (pan) between keyframes.
// Cut decision is driven by detected scene cuts and large pixel jumps —
// NOT by time gaps between samples, which were causing false cut classifications
// when sampling was sparser than the old 5-second time threshold.
function buildMotionExpression(
  keyframes: Keyframe[],
  axis: 'x' | 'y',
  maxVal: number,
  frameSize: number,
  sceneCuts: number[] = []
): string {
  const CUT_THRESHOLD = frameSize * 0.30  // 30% of frame width = likely a cut, not a pan

  let expr = String(keyframes[keyframes.length - 1][axis])

  for (let i = keyframes.length - 2; i >= 0; i--) {
    const k0 = keyframes[i]
    const k1 = keyframes[i + 1]
    const v0 = k0[axis]
    const v1 = k1[axis]
    const dt = k1.t - k0.t
    const dv = Math.abs(v1 - v0)
    if (dt <= 0) continue

    // A real cut exists between these two keyframes if scene detection found one.
    const hasSceneCut = sceneCuts.some(c => c > k0.t && c < k1.t)
    const isLargeJump = dv > CUT_THRESHOLD

    let segExpr: string

    if (hasSceneCut || isLargeJump) {
      // Known cut or huge pixel jump: hold position and snap at the next keyframe.
      segExpr = String(v0)
    } else {
      // Same continuous shot: smoothstep ease (3t² - 2t³) for natural movement.
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
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=540:960:flags=lanczos`
}
