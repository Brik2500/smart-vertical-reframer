import { FaceBox, FrameDimensions, TimedFace } from './faceDetection'
import { resolveSplitScreenPanes, SplitScreenPanes } from './splitScreenStabilizer'

export interface SplitScreenParams {
  top: { x: number; y: number; width: number; height: number }
  bottom: { x: number; y: number; width: number; height: number }
}

// Each person gets half the vertical 9:16 output.
// Uses full-height strips at each face's x position — same geometry as
// manualSplitParams. The old approach (top half / bottom half of source)
// was designed for vertically-stacked subjects; for side-by-side two-shots
// both faces land in the upper half of the source frame, so the bottom pane
// showed lower bodies instead of the second face.
export function computeSplitScreen(
  faceA: FaceBox,
  faceB: FaceBox,
  dims: FrameDimensions
): SplitScreenParams {
  // 9:8 strip from full source height → scales to 540x480 without distortion.
  // Each pane crops the full frame height at the subject's x position.
  const stripW = Math.floor(dims.height * 9 / 8)

  function clampX(centerX: number): number {
    return Math.max(0, Math.min(dims.width - stripW, Math.floor(centerX - stripW / 2)))
  }

  // Sort: top = face with smaller centerY (higher in frame).
  // For horizontal two-shots with similar Y positions this is effectively
  // stable order — consistent across frames in the same shot.
  const [topFace, bottomFace] = faceA.centerY <= faceB.centerY
    ? [faceA, faceB]
    : [faceB, faceA]

  return {
    top: {
      x: clampX(topFace.centerX),
      y: 0,
      width: stripW,
      height: dims.height,
    },
    bottom: {
      x: clampX(bottomFace.centerX),
      y: 0,
      width: stripW,
      height: dims.height,
    },
  }
}

export function buildSplitScreenFilter(params: SplitScreenParams): string {
  const { top, bottom } = params
  // Crop each half, scale each to 1080x960, then vstack
  return (
    `[0:v]crop=${top.width}:${top.height}:${top.x}:${top.y},scale=540:480:flags=lanczos[top];` +
    `[0:v]crop=${bottom.width}:${bottom.height}:${bottom.x}:${bottom.y},scale=540:480:flags=lanczos[bottom];` +
    `[top][bottom]vstack=inputs=2[out]`
  )
}

// Dynamic split-screen filter: per-sample pane tracking via splitScreenStabilizer.
// Handles the intermittent single-face case (head turn, occlusion, motion blur)
// by holding the missing pane at its last known position instead of duplicating
// the one visible face into both panes.
export function buildDynamicSplitScreenFilter(
  timedFaces: TimedFace[],
  dims: FrameDimensions,
  initialParams: SplitScreenParams
): string {
  const stripW = Math.floor(dims.height * 9 / 8)
  const maxX   = dims.width - stripW

  function toX(cx: number): number {
    return Math.max(0, Math.min(maxX, Math.floor(cx - stripW / 2)))
  }

  // Initialize pane centres from the segment's static crop params.
  let prevPanes: SplitScreenPanes = {
    top:    { cx: initialParams.top.x    + stripW / 2, width: stripW, lastUpdatedAt: 0 },
    bottom: { cx: initialParams.bottom.x + stripW / 2, width: stripW, lastUpdatedAt: 0 },
  }

  const topKF:    Array<{ t: number; x: number }> = []
  const bottomKF: Array<{ t: number; x: number }> = []

  // Sort by time — bracket samples arrive out of order relative to base grid.
  const sorted = [...timedFaces].sort((a, b) => a.time - b.time)

  for (const tf of sorted) {
    const detections = tf.faces.map(f => ({ cx: f.centerX, width: f.width }))
    const resolved = resolveSplitScreenPanes({ t: tf.time, detections, previousPanes: prevPanes })
    topKF.push(    { t: tf.time, x: toX(resolved.top.cx) })
    bottomKF.push( { t: tf.time, x: toX(resolved.bottom.cx) })
    prevPanes = resolved
  }

  const topX    = buildHoldExpr(topKF,    initialParams.top.x)
  const bottomX = buildHoldExpr(bottomKF, initialParams.bottom.x)

  return (
    `[0:v]crop=${stripW}:${dims.height}:'${topX}':0,scale=540:480:flags=lanczos[top];` +
    `[0:v]crop=${stripW}:${dims.height}:'${bottomX}':0,scale=540:480:flags=lanczos[bottom];` +
    `[top][bottom]vstack=inputs=2[out]`
  )
}

// Hold-and-snap expression: hold each keyframe's x until the next sample arrives.
// Simpler than smoothstep for split-screen since people move far less than
// cameras do between shots.
function buildHoldExpr(kfs: Array<{ t: number; x: number }>, fallback: number): string {
  if (kfs.length === 0) return String(fallback)
  let expr = String(kfs[kfs.length - 1].x)
  for (let i = kfs.length - 2; i >= 0; i--) {
    expr = `if(lt(t,${kfs[i + 1].t.toFixed(3)}),${kfs[i].x},${expr})`
  }
  if (kfs[0].t > 0) {
    expr = `if(lt(t,${kfs[0].t.toFixed(3)}),${fallback},${expr})`
  }
  return expr
}

// For split screen, ffmpeg must use -filter_complex and map [out]
export function isSplitScreen(): boolean {
  return true
}
