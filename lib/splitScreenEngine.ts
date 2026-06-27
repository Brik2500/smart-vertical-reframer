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
// Per-sample record used for dense end-of-segment logging.
type SplitSampleRecord = {
  t: number;
  detCount: number;
  topX: number; topCx: number; topFaceIdx: number | null;   // null = held
  botX: number; botCx: number; botFaceIdx: number | null;
}

export function buildDynamicSplitScreenFilter(
  timedFaces: TimedFace[],
  dims: FrameDimensions,
  initialParams: SplitScreenParams,
  segmentDuration?: number   // used only for dense end-of-segment logging
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

  const sampleLog: string[] = []
  const records: SplitSampleRecord[] = []

  for (const tf of sorted) {
    const detections = tf.faces.map(f => ({ cx: f.centerX, width: f.width }))
    const resolved = resolveSplitScreenPanes({ t: tf.time, detections, previousPanes: prevPanes })

    const topX = toX(resolved.top.cx)
    const botX = toX(resolved.bottom.cx)
    topKF.push(    { t: tf.time, x: topX })
    bottomKF.push( { t: tf.time, x: botX })

    // Infer which detected face index went to each pane (for logging only).
    let topFaceIdx: number | null = null
    let botFaceIdx: number | null = null
    if (detections.length >= 2) {
      const aToTop = Math.abs(detections[0].cx - resolved.top.cx) <= Math.abs(detections[1].cx - resolved.top.cx)
      topFaceIdx = aToTop ? 0 : 1
      botFaceIdx = aToTop ? 1 : 0
    } else if (detections.length === 1) {
      if (resolved.top.lastUpdatedAt    === tf.time) topFaceIdx = 0
      else                                           botFaceIdx = 0
    }

    records.push({ t: tf.time, detCount: detections.length,
      topX, topCx: resolved.top.cx,    topFaceIdx,
      botX, botCx: resolved.bottom.cx, botFaceIdx })

    const topStatus = topFaceIdx !== null ? `${topX}` : `HOLD(${topX})`
    const botStatus = botFaceIdx !== null ? `${botX}` : `HOLD(${botX})`
    sampleLog.push(`t=${tf.time.toFixed(2)} det=${detections.length} top=${topStatus} bot=${botStatus}`)

    prevPanes = resolved
  }

  console.log(`[split] samples (${sorted.length}): ${sampleLog.join(' | ')}`)

  // Dense end-of-segment logging: 0.1s ticks in the last 1s.
  // Evaluates the hold expression at each tick by looking up the active sample
  // (last sample at or before that time) — no new detections, logging only.
  if (segmentDuration !== undefined && records.length > 0) {
    const winStart = Math.max(0, segmentDuration - 1.0)
    const denseLogs: string[] = []
    for (let i = 0; i <= 10; i++) {
      const tick = parseFloat((winStart + i * 0.1).toFixed(2))
      if (tick > segmentDuration + 0.005) break
      let active: SplitSampleRecord | null = null
      for (const r of records) { if (r.t <= tick + 0.001) active = r }
      if (!active) continue
      const topLabel = active.topFaceIdx !== null
        ? `${active.topX}(face${active.topFaceIdx},cx=${active.topCx})`
        : `HOLD(${active.topX},cx=${active.topCx})`
      const botLabel = active.botFaceIdx !== null
        ? `${active.botX}(face${active.botFaceIdx},cx=${active.botCx})`
        : `HOLD(${active.botX},cx=${active.botCx})`
      denseLogs.push(`t=${tick.toFixed(2)} det=${active.detCount} top=${topLabel} bot=${botLabel}`)
    }
    if (denseLogs.length > 0) {
      console.log(`[split] dense ${winStart.toFixed(2)}-${segmentDuration.toFixed(2)}s: ${denseLogs.join(' | ')}`)
    }
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
