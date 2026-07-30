import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { TimedFace, FaceBox, FrameDimensions } from './faceDetection'
import { buildDynamicSmartCropFilter, buildSmartCropFilter, computeSmartCrop, ManualKeyframe } from './cropEngine'
import { buildSplitScreenFilter, buildDynamicSplitScreenFilter, computeSplitScreen, SplitScreenParams, DynamicSplitResult } from './splitScreenEngine'
import { TMP_DIR } from './videoUpload'

// What Vertiframe observed about the footage — describes the source, not the user's choice.
export type SegmentClassification = 'face-track' | 'low-confidence' | 'multi-subject'

// What gets rendered — layout-agnostic, decoupled from classification.
export type LayoutType = 'crop' | 'split-screen' | 'three-panel'

// Measurable editorial characteristics per segment.
// movementScore and cropStability are null until crop-path extraction is implemented (v2).
export interface EditorialMeta {
  trackingConfidence: number        // 0–1, average detection quality across samples
  cutDensity: number                // scene cuts per second within this segment
  speakerSwitchRate: number | null  // dominant-face switches per sample; null for single-subject
  movementScore: null               // reserved for v2 crop-path analysis
  cropStability: null               // reserved for v2 crop-path analysis
  analysisVersion: 1
}

export interface VideoSegment {
  start: number               // seconds into source video
  end: number
  type: 'smart-crop' | 'split-screen' | 'context'  // retained for render-branch compatibility
  timedFaces: TimedFace[]     // samples that fall in this segment (global timestamps)
  splitFaces?: [FaceBox, FaceBox]
  manualSplitParams?: SplitScreenParams  // set when user manually positioned both boxes
  // canonical architecture fields — populated by buildCanonicalSegments(), absent on legacy segments
  id?: string
  classification?: SegmentClassification
  defaultLayout?: LayoutType
  editorialMeta?: EditorialMeta
}

// Confidence score 0–1 for a set of detection samples.
// face=1.0, object=0.7, saliency=0.3, center=0.0
// A segment scoring below CONTEXT_THRESHOLD triggers the three-panel context layout.
const CONTEXT_THRESHOLD = 0.35

function segmentConfidence(samples: TimedFace[]): number {
  if (samples.length === 0) return 0
  const scores: number[] = samples.map(tf => {
    switch (tf.detectionType) {
      case 'face':     return 1.0
      case 'object':   return 0.7
      case 'saliency': return 0.3
      default:         return 0.0  // 'center'
    }
  })
  return scores.reduce((a, b) => a + b, 0) / scores.length
}

function typeToClassification(type: VideoSegment['type']): SegmentClassification {
  if (type === 'split-screen') return 'multi-subject'
  if (type === 'context')      return 'low-confidence'
  return 'face-track'
}

function typeToLayout(type: VideoSegment['type']): LayoutType {
  if (type === 'split-screen') return 'split-screen'
  if (type === 'context')      return 'three-panel'
  return 'crop'
}

function computeEditorialMeta(seg: VideoSegment, sceneCuts: number[]): EditorialMeta {
  const duration = seg.end - seg.start
  const trackingConfidence = segmentConfidence(seg.timedFaces)
  const cutsInSegment = sceneCuts.filter(c => c > seg.start && c < seg.end).length
  const cutDensity = duration > 0 ? cutsInSegment / duration : 0

  let speakerSwitchRate: number | null = null
  if (seg.type === 'split-screen') {
    const twoFaceSamples = seg.timedFaces.filter(tf => tf.faces.length >= 2)
    if (twoFaceSamples.length >= 2) {
      let switches = 0
      let prevDominantWasLeft: boolean | null = null
      for (const tf of twoFaceSamples) {
        const [a, b] = tf.faces
        const aArea = a.width * a.height
        const bArea = b.width * b.height
        const dominant = aArea >= bArea ? a : b
        const midX = (a.centerX + b.centerX) / 2
        const isLeft = dominant.centerX < midX
        if (prevDominantWasLeft !== null && isLeft !== prevDominantWasLeft) switches++
        prevDominantWasLeft = isLeft
      }
      speakerSwitchRate = switches / (twoFaceSamples.length - 1)
    } else {
      speakerSwitchRate = 0
    }
  }

  return {
    trackingConfidence,
    cutDensity,
    speakerSwitchRate,
    movementScore: null,
    cropStability: null,
    analysisVersion: 1,
  }
}

// Build the canonical segment set: classify once, stamp stable IDs and editorial metadata.
// This is the authoritative segment model — store it on the Job after detection so the
// renderer consumes it directly without reclassifying.
export function buildCanonicalSegments(
  timedFaces: TimedFace[],
  dims: FrameDimensions,
  duration: number,
  sceneCuts: number[] = []
): VideoSegment[] {
  const base = classifySegments(timedFaces, dims, duration, sceneCuts)
  return base.map(seg => ({
    ...seg,
    id: randomUUID(),
    classification: typeToClassification(seg.type),
    defaultLayout: typeToLayout(seg.type),
    editorialMeta: computeEditorialMeta(seg, sceneCuts),
  }))
}

function ffmpegBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ffmpeg-static') as string
}

// Classify the video timeline into typed segments based on shot type.
// Two-shot detection: 2 faces co-present, spanning >50% of frame width.
// Adjacent same-type samples merge into one segment.
// Boundaries are set at the midpoint between adjacent samples of different types.
export function classifySegments(
  timedFaces: TimedFace[],
  dims: FrameDimensions,
  duration: number,
  sceneCuts: number[] = []
): VideoSegment[] {
  if (timedFaces.length === 0) {
    return [{ start: 0, end: duration, type: 'smart-crop', timedFaces: [] }]
  }

  // Label each sample
  const labeled = timedFaces.map(tf => {
    let isTwoShot = false
    let splitFaces: [FaceBox, FaceBox] | undefined

    if (tf.faces.length >= 2) {
      const a = tf.faces[0]
      const b = tf.faces[1]
      const span =
        Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x)
      const threshold = dims.width * 0.50
      console.log(`[DEBUG] classify t=${tf.time}s → 2 faces, span=${Math.round(span)} threshold=${Math.round(threshold)} → ${span > threshold ? 'SPLIT_SCREEN' : 'span too small'}`)
      if (span > threshold) {
        isTwoShot = true
        splitFaces = [a, b]
      }
    } else {
      console.log(`[DEBUG] classify t=${tf.time}s → ${tf.faces.length} face(s) → SMART_CROP`)
    }
    return { tf, isTwoShot, splitFaces }
  })

  // Group consecutive same-type samples into segments
  const segments: VideoSegment[] = []
  let segStartTime = 0
  let segType = labeled[0].isTwoShot
  let segSamples = [labeled[0].tf]
  let segSplitFaces: [FaceBox, FaceBox] | undefined = labeled[0].splitFaces

  for (let i = 1; i < labeled.length; i++) {
    const prev = labeled[i - 1]
    const curr = labeled[i]

    // A scene cut between samples is always a hard boundary — even if the type vote
    // didn't change, the two shots must not share a classification run. Using the cut
    // timestamp (not the sample midpoint) as the boundary ensures post-cut content
    // is never rendered with pre-cut crop positions.
    const cutBetween = sceneCuts.find(c => c > prev.tf.time && c <= curr.tf.time)
    const typeChanged = curr.isTwoShot !== segType

    if (typeChanged || cutBetween !== undefined) {
      const boundary = cutBetween ?? (prev.tf.time + curr.tf.time) / 2

      console.log(
        `[classify] seg ${segStartTime.toFixed(2)}→${boundary.toFixed(2)} ` +
        `type=${segType ? 'SPLIT_SCREEN' : 'SMART_CROP'} ` +
        `samples=${segSamples.length} ` +
        `reason=${cutBetween !== undefined ? `cut@${cutBetween.toFixed(2)}` : 'type-change'}`
      )

      segments.push({
        start: segStartTime,
        end: boundary,
        type: segType ? 'split-screen' : 'smart-crop',
        timedFaces: segSamples,
        splitFaces: segSplitFaces,
      })

      segStartTime = boundary
      segType = curr.isTwoShot
      segSamples = [curr.tf]
      segSplitFaces = curr.splitFaces
    } else {
      segSamples.push(curr.tf)
      if (curr.splitFaces) segSplitFaces = curr.splitFaces
    }
  }

  // Final segment runs to end of video
  segments.push({
    start: segStartTime,
    end: duration,
    type: segType ? 'split-screen' : 'smart-crop',
    timedFaces: segSamples,
    splitFaces: segSplitFaces,
  })

  // Confidence pass: downgrade low-confidence smart-crop segments to context layout.
  // Split-screen segments are never downgraded — two detected faces is already
  // meaningful signal; the context layout would add no value there.
  for (const seg of segments) {
    if (seg.type !== 'smart-crop') continue
    const conf = segmentConfidence(seg.timedFaces)
    if (conf < CONTEXT_THRESHOLD) {
      console.log(`[classify] context-layout trigger: ${seg.start.toFixed(2)}→${seg.end.toFixed(2)} conf=${conf.toFixed(2)} < ${CONTEXT_THRESHOLD}`)
      seg.type = 'context'
    }
  }

  // Split any segment that spans an internal scene cut.
  // classifySegments boundaries are detection-sample midpoints, independent of cuts,
  // so a single face-count run can span multiple shots. Splitting here ensures no
  // segment ever applies pre-cut hold positions to post-cut content during render.
  //
  // The end guard is intentionally absent: we filter only the start boundary (cut must
  // be > seg.start + 0.02 to avoid zero-width pre-cut slivers), but allow cuts right up
  // to seg.end. When a cut lands within MIN_SLIVER of the end, we snap the segment end
  // to the cut and shift the following segment's start back rather than creating a
  // meaningless tiny tail sub-segment.
  if (sceneCuts.length > 0) {
    const MIN_SLIVER = 0.5
    const split: VideoSegment[] = []
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si]
      const internal = sceneCuts
        .filter(c => c > seg.start + 0.02 && c < seg.end)
        .sort((a, b) => a - b)
      if (internal.length === 0) {
        split.push(seg)
        continue
      }
      let cursor = seg.start
      let snapped = false
      for (const cut of internal) {
        const tail = seg.end - cut
        if (tail < MIN_SLIVER) {
          // Tiny tail after this cut — snap segment end to the cut and extend the
          // next segment's start back to fill the gap. Avoids a meaningless sliver
          // of post-cut content being rendered with stale pre-cut crop positions.
          split.push(makeSubSegment(seg, cursor, cut, dims))
          if (si + 1 < segments.length) {
            segments[si + 1] = { ...segments[si + 1], start: cut }
          }
          snapped = true
          break
        }
        split.push(makeSubSegment(seg, cursor, cut, dims))
        cursor = cut
      }
      if (!snapped) {
        split.push(makeSubSegment(seg, cursor, seg.end, dims))
      }
    }
    segments.length = 0
    segments.push(...split)
  }

  console.log(`[DEBUG] ─── SEGMENTS (${segments.length}) ───`)
  segments.forEach(s => console.log(`[DEBUG]   ${s.type.toUpperCase().padEnd(14)} ${s.start.toFixed(1)}s → ${s.end.toFixed(1)}s`))

  return segments
}

// Slice a parent segment to [from, to) and re-evaluate its type using only
// the face samples in that window. Re-evaluation is required because a scene
// cut can change face count even within a continuous face-count run
// (e.g. two-shot → single-person after the cut).
function makeSubSegment(
  parent: VideoSegment,
  from: number,
  to: number,
  dims: FrameDimensions
): VideoSegment {
  const faces = parent.timedFaces.filter(tf => tf.time >= from && tf.time < to)

  let isTwoShot = false
  let splitFaces: [FaceBox, FaceBox] | undefined

  // Require ≥2 detection timestamps before classifying as split-screen.
  // A sub-segment with only 1 timestamp is typically a transition window where
  // the detection-sample midpoint landed far from the actual shot boundary —
  // applying static split-screen positions to the whole window causes duplicate-
  // face frames for the unsampled portion before the detection. Smart-crop is
  // a safer fallback: it shows a single centered pane rather than broken splits.
  if (faces.length >= 2) {
    for (const tf of faces) {
      if (tf.faces.length >= 2) {
        const a = tf.faces[0], b = tf.faces[1]
        const span = Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x)
        if (span > dims.width * 0.5) {
          isTwoShot = true
          splitFaces = [a, b]
          break
        }
      }
    }
  }

  const votes = faces.map(tf => {
    if (tf.faces.length < 2) return `t=${tf.time.toFixed(2)}:SMART_CROP(${tf.faces.length}face)`
    const a = tf.faces[0], b = tf.faces[1]
    const span = Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x)
    const qualifies = span > dims.width * 0.5
    return `t=${tf.time.toFixed(2)}:${qualifies ? 'SPLIT_SCREEN' : 'SMART_CROP'}(span=${Math.round(span)})`
  })
  console.log(
    `[classify] makeSubSeg ${from.toFixed(2)}→${to.toFixed(2)} ` +
    `parent=${parent.type} samples=${faces.length} ` +
    `result=${isTwoShot ? 'SPLIT_SCREEN' : 'SMART_CROP'} [${votes.join(' ')}]`
  )

  const baseType = isTwoShot ? 'split-screen' : 'smart-crop'
  const conf = segmentConfidence(faces)
  const type: VideoSegment['type'] = (baseType === 'smart-crop' && conf < CONTEXT_THRESHOLD)
    ? 'context'
    : baseType

  if (type === 'context') {
    console.log(`[classify] makeSubSeg context-layout: ${from.toFixed(2)}→${to.toFixed(2)} conf=${conf.toFixed(2)}`)
  }

  return {
    start: from,
    end: to,
    type,
    timedFaces: faces,
    splitFaces,
    manualSplitParams: isTwoShot ? parent.manualSplitParams : undefined,
  }
}

// Offset timed face timestamps to be relative to segment start.
// Critical: FFmpeg's `t` variable resets to 0 at the start of each extracted segment.
function offsetFaces(timedFaces: TimedFace[], offset: number): TimedFace[] {
  return timedFaces.map(tf => ({ ...tf, time: Math.max(0, tf.time - offset) }))
}

// Approximate the crop X a neighboring smart-crop segment will produce at its
// boundary — used as a stale-hold ease target in buildFFmpegExprFromSegments.
// Mirrors cropEngine's edge-margin clamping but skips the full outlier-rejection
// pipeline; good enough as a directional hint, not a precise keyframe value.
// Returns undefined for split-screen neighbors (incompatible geometry) and when
// no usable (non-center) face detection exists in the segment.
function getNeighborCropX(
  seg: VideoSegment | undefined,
  dims: FrameDimensions,
  which: 'first' | 'last'
): number | undefined {
  if (!seg || seg.type !== 'smart-crop') return undefined
  const cropW = Math.floor(dims.height * 9 / 16)
  const edgeMarginX = Math.floor(cropW * 0.08)
  const maxX = dims.width - cropW
  const usable = [...seg.timedFaces]
    .filter(tf => tf.faces.length > 0 && tf.detectionType !== 'center' && tf.detectionType !== 'saliency')
    .sort((a, b) => a.time - b.time)
  const tf = which === 'first' ? usable[0] : usable[usable.length - 1]
  if (!tf) return undefined
  const rawX = Math.floor(tf.faces[0].centerX - cropW / 2)
  return Math.max(edgeMarginX, Math.min(maxX - edgeMarginX, rawX))
}

// Render each segment to a temp file, then concatenate into the final output.
export function renderVideoWithSegments(
  inputPath: string,
  segments: VideoSegment[],
  dims: FrameDimensions,
  jobId: string,
  outputPath: string,
  manualKeyframes: ManualKeyframe[] = [],
  sceneCuts: number[] = []
): void {
  const ffmpeg = ffmpegBin()

  if (segments.length === 1) {
    console.log(`[render] single segment — starting FFmpeg render`)
    renderSegment(ffmpeg, inputPath, segments[0], dims, outputPath, jobId, manualKeyframes, sceneCuts, null, undefined, undefined, undefined, undefined)
    console.log(`[render] FFmpeg render complete`)
    return
  }

  const segPaths: string[] = []
  let lastValidSplitParams: SplitScreenParams | null = null
  // Track the actual rendered ending X of the previous split-screen segment so the
  // next segment's pre-roll fallback starts from where the last frame actually was,
  // not from a face-derived initial position that can differ by tens of pixels.
  let prevSplitEndTopX: number | undefined
  let prevSplitEndBotX: number | undefined

  for (let i = 0; i < segments.length; i++) {
    const segOut = path.join(TMP_DIR, `${jobId}_seg${i}.mp4`)
    console.log(`[render] segment ${i + 1}/${segments.length} (${segments[i].type}) ${segments[i].start.toFixed(1)}s→${segments[i].end.toFixed(1)}s`)
    const nextSegFirstX = getNeighborCropX(segments[i + 1], dims, 'first')
    const prevSegLastX  = getNeighborCropX(segments[i - 1], dims, 'last')
    const splitResult = renderSegment(ffmpeg, inputPath, segments[i], dims, segOut, jobId, manualKeyframes, sceneCuts, lastValidSplitParams, nextSegFirstX, prevSegLastX, prevSplitEndTopX, prevSplitEndBotX)
    console.log(`[render] segment ${i + 1}/${segments.length} done`)
    segPaths.push(segOut)

    if (splitResult) {
      prevSplitEndTopX = splitResult.endTopX
      prevSplitEndBotX = splitResult.endBotX
    } else if (segments[i].type !== 'split-screen') {
      // Non-split segment breaks the chain — next split starts fresh
      prevSplitEndTopX = undefined
      prevSplitEndBotX = undefined
    }

    // Advance the fallback pointer only on genuinely distinct pane positions.
    const seg = segments[i]
    if (seg.type === 'split-screen') {
      const sp = seg.manualSplitParams
        ?? (seg.splitFaces ? computeSplitScreen(seg.splitFaces[0], seg.splitFaces[1], dims) : null)
      if (sp && sp.top.x !== sp.bottom.x) {
        lastValidSplitParams = sp
      }
    }
  }

  // Write concat playlist and merge
  const playlistPath = path.join(TMP_DIR, `${jobId}_playlist.txt`)
  fs.writeFileSync(playlistPath, segPaths.map(p => `file '${p}'`).join('\n'))

  console.log(`[render] concat ${segments.length} segments → final output`)
  execFileSync(ffmpeg, [
    '-loglevel', 'error',
    '-f', 'concat',
    '-safe', '0',
    '-i', playlistPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    outputPath, '-y',
  ], { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 })
  console.log(`[render] concat done — output ready`)
}

// Build an FFmpeg filter_complex for the three-panel context layout.
// Output: 1080x1920 (9:16)
//   Top    1080x640 — subject crop (best available face, or centered fallback)
//   Middle 1080x640 — original wide frame letterboxed (never cropped)
//   Bottom 1080x640 — same crop as top (single-subject footage) or second subject
//
// Panel aspect: 1080/640 = 1.6875 ≈ 16:9.6 — close enough to 16:9 that the
// letterboxed wide panel reads naturally without visible distortion.
function buildContextFilter(dims: FrameDimensions, cropX: number, cropX2?: number): string {
  // Crop width for top/bottom panels: half the source width so each panel can
  // isolate one subject. Using the old formula (height * 1080/640) produced a
  // 1822px window on 1920px sources, leaving only 98px of horizontal range and
  // making both panels look identical.
  const panelOutW = 1080
  const panelOutH = 640
  const cropW = Math.floor(dims.width / 2 / 2) * 2        // half source width, keep even
  const cropH = Math.floor(cropW * panelOutH / panelOutW / 2) * 2  // maintain 27:16 ratio
  const cropY = Math.floor((dims.height - cropH) / 2)     // center vertically
  const clampX = (x: number) => Math.max(0, Math.min(dims.width - cropW, x))

  const topX = clampX(cropX)
  const botX = clampX(cropX2 ?? cropX)

  // Middle panel: scale full source to fit 1080w, letterbox to 640h.
  const midH = Math.floor(dims.height * (panelOutW / dims.width) / 2) * 2
  const padTop = Math.floor((panelOutH - midH) / 2)

  return [
    `[0:v]split=3[top_src][mid_src][bot_src]`,
    `[top_src]crop=${cropW}:${cropH}:${topX}:${cropY},scale=${panelOutW}:${panelOutH}[top]`,
    `[mid_src]scale=${panelOutW}:${midH},pad=${panelOutW}:${panelOutH}:0:${padTop}:black[mid]`,
    `[bot_src]crop=${cropW}:${cropH}:${botX}:${cropY},scale=${panelOutW}:${panelOutH}[bot]`,
    `[top][mid][bot]vstack=inputs=3[out]`,
  ].join(';')
}

function renderSegment(
  ffmpeg: string,
  inputPath: string,
  seg: VideoSegment,
  dims: FrameDimensions,
  outputPath: string,
  jobId: string,
  manualKeyframes: ManualKeyframe[] = [],
  sceneCuts: number[] = [],
  lastValidSplitParams: SplitScreenParams | null = null,
  nextSegmentFirstX?: number,
  prevSegmentLastX?: number,
  prevSplitEndTopX?: number,
  prevSplitEndBotX?: number
): DynamicSplitResult | null {
  const duration = seg.end - seg.start
  const baseArgs = [
    '-ss', String(seg.start),
    '-i', inputPath,
    '-t', String(duration),
  ]

  const splitParams = seg.type === 'split-screen'
    ? (seg.manualSplitParams ?? (seg.splitFaces ? computeSplitScreen(seg.splitFaces[0], seg.splitFaces[1], dims) : null))
    : null

  if (splitParams) {
    const localFaces = offsetFaces(seg.timedFaces, seg.start)

    let effectiveSplitParams = splitParams
    if (localFaces.length < 2) {
      if (splitParams.top.x === splitParams.bottom.x) {
        // Both panes point at the same source X — would show the same content in both
        // output halves. Inherit the last segment that had distinct, usable positions.
        if (lastValidSplitParams) {
          console.warn(
            `[split] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)}: ` +
            `${localFaces.length} sample(s), degenerate static params (top=bot=${splitParams.top.x}) — ` +
            `inheriting panes from prior segment: top=${lastValidSplitParams.top.x} bot=${lastValidSplitParams.bottom.x}`
          )
          effectiveSplitParams = lastValidSplitParams
        } else {
          // No prior segment with valid positions — spread strips to maximum separation.
          // top.width and bottom.width are always equal (both use dims.height * 9/8).
          const maxX = dims.width - splitParams.top.width
          effectiveSplitParams = {
            top:    { ...splitParams.top,    x: 0    },
            bottom: { ...splitParams.bottom, x: maxX },
          }
          console.warn(
            `[split] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)}: ` +
            `${localFaces.length} sample(s), degenerate static params (top=bot=${splitParams.top.x}), ` +
            `no prior split data — using spread default (top=0 bot=${maxX})`
          )
        }
      } else {
        // Non-degenerate static params, too few samples for dynamic filter — log only.
        console.log(
          `[split] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)}: ` +
          `${localFaces.length} sample(s) — static params top=${splitParams.top.x} bot=${splitParams.bottom.x}`
        )
      }

      // Diagnostic: when a single sample reports 2 faces, check whether the two
      // bounding boxes look like the same person detected twice (motion blur,
      // reflection, partial occlusion). Genuine two-person detections should have
      // well-separated, non-overlapping boxes. Flag as SUSPECT_DUPLICATE if IoU
      // exceeds 0.4 or center distance is < 30% of average face width.
      if (localFaces.length === 1 && localFaces[0].faces.length >= 2) {
        const fa = localFaces[0].faces[0]
        const fb = localFaces[0].faces[1]
        const xOverlap = Math.max(0, Math.min(fa.x + fa.width, fb.x + fb.width) - Math.max(fa.x, fb.x))
        const yOverlap = Math.max(0, Math.min(fa.y + fa.height, fb.y + fb.height) - Math.max(fa.y, fb.y))
        const intersection = xOverlap * yOverlap
        const union = fa.width * fa.height + fb.width * fb.height - intersection
        const iou = union > 0 ? intersection / union : 0
        const centerDist = Math.abs(fa.centerX - fb.centerX)
        const avgWidth = (fa.width + fb.width) / 2
        const suspect = iou > 0.4 || centerDist < avgWidth * 0.3
        console.log(
          `[split] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)}: 1-sample 2-face detection — ` +
          `faceA=[x=${fa.x},y=${fa.y},w=${fa.width},h=${fa.height},cx=${fa.centerX.toFixed(0)}] ` +
          `faceB=[x=${fb.x},y=${fb.y},w=${fb.width},h=${fb.height},cx=${fb.centerX.toFixed(0)}] ` +
          `iou=${iou.toFixed(3)} centerDist=${centerDist.toFixed(0)}px avgW=${avgWidth.toFixed(0)}px` +
          (suspect ? ' ⚑ SUSPECT_DUPLICATE' : '')
        )
      }
    }

    let dynamicResult: DynamicSplitResult | null = null
    const filterComplex = localFaces.length >= 2
      ? (dynamicResult = buildDynamicSplitScreenFilter(localFaces, dims, effectiveSplitParams, duration, prevSplitEndTopX, prevSplitEndBotX)).filter
      : buildSplitScreenFilter(effectiveSplitParams)

    execFileSync(ffmpeg, [
      '-loglevel', 'error',
      ...baseArgs,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac',
      outputPath, '-y',
    ], { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 })
    return dynamicResult
  } else if (seg.type === 'context') {
    // Three-panel layout: top = face A crop, middle = original frame, bottom = face B crop.
    // Panel aspect ratio is 1080×640 (27:16), so each crop strip is wider than a 9:16 crop.
    const cropW = Math.floor(dims.width / 2 / 2) * 2
    const clamp = (x: number) => Math.max(0, Math.min(dims.width - cropW, x))
    const centerX = clamp(Math.floor((dims.width - cropW) / 2))

    let topX: number
    let botX: number

    if (seg.splitFaces && seg.splitFaces[0] && seg.splitFaces[1]
        && Math.abs(seg.splitFaces[0].centerX - seg.splitFaces[1].centerX) > 50) {
      // Two distinct faces already identified by the split-screen classifier.
      // Sort by centerX so left subject is always top panel, right is always bottom.
      // This keeps each person in the same panel for the entire segment.
      const [fA, fB] = [...seg.splitFaces].sort((a, b) => a.centerX - b.centerX)
      topX = clamp(Math.floor(fA.centerX - cropW / 2))
      botX = clamp(Math.floor(fB.centerX - cropW / 2))
      console.log(`[context] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)} using splitFaces topX=${topX} (cx=${Math.round(fA.centerX)}) botX=${botX} (cx=${Math.round(fB.centerX)})`)
    } else {
      // Fall back: cluster all face detections in the segment into left and right groups.
      // Average each cluster's centerX to find the two persistent subject positions.
      const allFaces = seg.timedFaces
        .filter(tf => tf.detectionType === 'face' && tf.faces.length > 0)
        .flatMap(tf => tf.faces)

      if (allFaces.length >= 2) {
        const sorted = [...allFaces].sort((a, b) => a.centerX - b.centerX)
        const mid = Math.floor(sorted.length / 2)
        const avg = (arr: FaceBox[]) => arr.reduce((s, f) => s + f.centerX, 0) / arr.length
        topX = clamp(Math.floor(avg(sorted.slice(0, mid)) - cropW / 2))
        botX = clamp(Math.floor(avg(sorted.slice(mid)) - cropW / 2))
        console.log(`[context] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)} clustered topX=${topX} botX=${botX} (${allFaces.length} faces)`)
      } else {
        topX = centerX
        botX = centerX
        console.log(`[context] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)} insufficient faces — centering both panels`)
      }
    }

    const filterComplex = buildContextFilter(dims, topX, botX)

    execFileSync(ffmpeg, [
      '-loglevel', 'error',
      ...baseArgs,
      '-filter_complex', filterComplex,
      '-map', '[out]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac',
      outputPath, '-y',
    ], { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 })
    return null

  } else {
    const localFaces = offsetFaces(seg.timedFaces, seg.start)
    // Offset scene cut timestamps to local segment time (t=0 at seg.start).
    // Use <= for the end boundary so cuts that fall exactly at the segment edge are
    // included — previously < excluded boundary cuts, causing them to be absent from
    // localCuts and misclassified as 'pan' by classifySegments in smartCropStabilizer.
    const localCuts = sceneCuts.map(c => c - seg.start).filter(c => c > 0 && c <= seg.end - seg.start)
    // Restrict manual keyframes to this segment's time range and convert to local time.
    // The global list includes keyframes from other segments; passing it unfiltered causes
    // out-of-segment keyframes to appear at wrong offsets for seg.start > 0 and produces
    // spurious pan transitions to unrelated shots across cut boundaries.
    const localManualKF = manualKeyframes
      .filter(mk => mk.t >= seg.start && mk.t <= seg.end)
      .map(mk => ({ ...mk, t: mk.t - seg.start }))
    const CUT_EPSILON = 0.05
    const segStartsAtCut = sceneCuts.some(c => Math.abs(c - seg.start) < CUT_EPSILON)
    const segEndsAtCut   = sceneCuts.some(c => Math.abs(c - seg.end)   < CUT_EPSILON)
    let vf: string
    if (localFaces.length > 1) {
      vf = buildDynamicSmartCropFilter(localFaces, dims, localManualKF, localCuts, duration, nextSegmentFirstX, prevSegmentLastX, segEndsAtCut, segStartsAtCut)
    } else {
      const face = localFaces[0]?.faces[0] ?? null
      const crop = computeSmartCrop(face, dims)
      console.log(
        `[crop] seg ${seg.start.toFixed(2)}→${seg.end.toFixed(2)}: static fallback ` +
        `(${localFaces.length} detection(s)) face=${face ? `cx=${face.centerX.toFixed(0)}` : 'null'} → x=${crop.x}`
      )
      vf = buildSmartCropFilter(crop)
    }

    execFileSync(ffmpeg, [
      '-loglevel', 'error',
      ...baseArgs,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac',
      outputPath, '-y',
    ], { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 })
    return null
  }
}
