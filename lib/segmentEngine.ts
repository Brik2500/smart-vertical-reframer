import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { TimedFace, FaceBox, FrameDimensions } from './faceDetection'
import { buildDynamicSmartCropFilter, buildSmartCropFilter, computeSmartCrop, ManualKeyframe } from './cropEngine'
import { buildSplitScreenFilter, buildDynamicSplitScreenFilter, computeSplitScreen, SplitScreenParams } from './splitScreenEngine'
import { TMP_DIR } from './videoUpload'

export interface VideoSegment {
  start: number               // seconds into source video
  end: number
  type: 'smart-crop' | 'split-screen'
  timedFaces: TimedFace[]     // samples that fall in this segment (global timestamps)
  splitFaces?: [FaceBox, FaceBox]
  manualSplitParams?: SplitScreenParams  // set when user manually positioned both boxes
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

    if (curr.isTwoShot !== segType) {
      // Type change — boundary is the midpoint between previous and current sample
      const boundary = (prev.tf.time + curr.tf.time) / 2

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

  // Split any segment that spans an internal scene cut.
  // classifySegments boundaries are detection-sample midpoints, independent of cuts,
  // so a single face-count run can span multiple shots. Splitting here ensures no
  // segment ever applies pre-cut hold positions to post-cut content during render.
  if (sceneCuts.length > 0) {
    const split: VideoSegment[] = []
    for (const seg of segments) {
      const internal = sceneCuts
        .filter(c => c > seg.start + 0.02 && c < seg.end - 0.02)
        .sort((a, b) => a - b)
      if (internal.length === 0) {
        split.push(seg)
        continue
      }
      let cursor = seg.start
      for (const cut of internal) {
        split.push(makeSubSegment(seg, cursor, cut, dims))
        cursor = cut
      }
      split.push(makeSubSegment(seg, cursor, seg.end, dims))
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

  return {
    start: from,
    end: to,
    type: isTwoShot ? 'split-screen' : 'smart-crop',
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
    renderSegment(ffmpeg, inputPath, segments[0], dims, outputPath, jobId, manualKeyframes, sceneCuts)
    console.log(`[render] FFmpeg render complete`)
    return
  }

  const segPaths: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const segOut = path.join(TMP_DIR, `${jobId}_seg${i}.mp4`)
    console.log(`[render] segment ${i + 1}/${segments.length} (${segments[i].type}) ${segments[i].start.toFixed(1)}s→${segments[i].end.toFixed(1)}s`)
    renderSegment(ffmpeg, inputPath, segments[i], dims, segOut, jobId, manualKeyframes, sceneCuts)
    console.log(`[render] segment ${i + 1}/${segments.length} done`)
    segPaths.push(segOut)
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

function renderSegment(
  ffmpeg: string,
  inputPath: string,
  seg: VideoSegment,
  dims: FrameDimensions,
  outputPath: string,
  jobId: string,
  manualKeyframes: ManualKeyframe[] = [],
  sceneCuts: number[] = []
): void {
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
    const filterComplex = localFaces.length >= 2
      ? buildDynamicSplitScreenFilter(localFaces, dims, splitParams, duration)
      : buildSplitScreenFilter(splitParams)

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
  } else {
    const localFaces = offsetFaces(seg.timedFaces, seg.start)
    // Offset scene cut timestamps to match local segment time (t=0 at seg.start)
    const localCuts = sceneCuts.map(c => c - seg.start).filter(c => c > 0 && c < seg.end - seg.start)
    const vf = localFaces.length > 1
      ? buildDynamicSmartCropFilter(localFaces, dims, manualKeyframes, localCuts)
      : buildSmartCropFilter(computeSmartCrop(localFaces[0]?.faces[0] ?? null, dims))

    execFileSync(ffmpeg, [
      '-loglevel', 'error',
      ...baseArgs,
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac',
      outputPath, '-y',
    ], { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 })
  }
}
