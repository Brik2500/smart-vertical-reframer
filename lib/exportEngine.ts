import path from 'path'
import { TMP_DIR } from './videoUpload'
import { detectFacesOverTime, decideSplitScreen, getVideoDuration, TimedFace, FrameDimensions } from './faceDetection'
import { classifySegments, renderVideoWithSegments, VideoSegment } from './segmentEngine'
import { SplitScreenParams } from './splitScreenEngine'
import { computeSmartCrop } from './cropEngine'
import { detectSceneCuts } from './sceneDetection'
import type { SampledFrame } from './jobStore'
import type { ManualKeyframe } from './cropEngine'

export type ReframingMode = 'smart-crop' | 'split-screen' | 'auto'

export async function detectVideo(
  jobId: string,
  inputPath: string
): Promise<{ timedFaces: TimedFace[]; dims: FrameDimensions; sampledFrames: SampledFrame[]; sceneCuts: number[] }> {
  const { timedFaces, dims } = await detectFacesOverTime(inputPath, jobId, 20)
  const sceneCuts = detectSceneCuts(inputPath)

  console.log(`[detect] found ${sceneCuts.length} scene cuts:`, sceneCuts.map(t => t.toFixed(2)).join(', '))

  const sampledFrames: SampledFrame[] = timedFaces.map(tf => {
    const face = tf.faces[0] ?? null
    const crop = computeSmartCrop(face, dims)
    const filename = `frame_t${tf.time.toFixed(2).replace('.', '_')}.jpg`
    return {
      time: tf.time,
      filename,
      frameW: dims.width,
      frameH: dims.height,
      cropX: crop.x,
      cropW: crop.width,
      detectionType: tf.detectionType,
      faceCount: tf.faces.length,
    }
  })

  return { timedFaces, dims, sampledFrames, sceneCuts }
}

export interface SplitOverride {
  time: number
  cropX: number   // top-half X position
  cropX2: number  // bottom-half X position
}

export async function renderVideo(
  jobId: string,
  inputPath: string,
  mode: ReframingMode,
  dims: FrameDimensions,
  timedFaces: TimedFace[],
  manualKeyframes: ManualKeyframe[] = [],
  splitOverrides: SplitOverride[] = [],
  sceneCuts: number[] = []
): Promise<string> {
  const outputPath = path.join(TMP_DIR, `${jobId}_output.mp4`)
  const duration = getVideoDuration(inputPath)

  if (mode === 'split-screen') {
    const decision = decideSplitScreen(timedFaces, dims, 'split-screen')
    if (decision.useSplitScreen && decision.splitFaces) {
      const segments = [{ start: 0, end: duration, type: 'split-screen' as const, timedFaces, splitFaces: decision.splitFaces }]
      renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes, sceneCuts)
      return outputPath
    }
  }

  if (mode === 'smart-crop') {
    const segments = [{ start: 0, end: duration, type: 'smart-crop' as const, timedFaces }]
    applyManualSplitScreens(segments, splitOverrides, dims, timedFaces, sceneCuts)
    renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes, sceneCuts)
    return outputPath
  }

  const segments = classifySegments(timedFaces, dims, duration)
  applyManualSplitScreens(segments, splitOverrides, dims, timedFaces, sceneCuts)
  renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes, sceneCuts)
  return outputPath
}

// Build SplitScreenParams from two manually positioned crop X values.
// Both crops span the FULL source height so each subject is shown head-to-toe,
// not cut at the midpoint of the frame. Each vertical strip is 9:8 wide
// (matching the 1080x960 output half) and independently positioned.
function manualSplitParams(ov: SplitOverride, dims: FrameDimensions): SplitScreenParams {
  const stripW = Math.floor(dims.height * 9 / 8)  // 9:8 strip from full source height
  const clamp = (x: number) => Math.max(0, Math.min(dims.width - stripW, x))
  return {
    top:    { x: clamp(ov.cropX),  y: 0, width: stripW, height: dims.height },
    bottom: { x: clamp(ov.cropX2), y: 0, width: stripW, height: dims.height },
  }
}

// Split the containing segment around each manually marked split-screen frame.
// Uses midpoints to adjacent sampled frames as boundaries (same logic as classifySegments),
// so only the window around the marked frame becomes split-screen.
function applyManualSplitScreens(
  segments: VideoSegment[],
  overrides: SplitOverride[],
  dims: FrameDimensions,
  timedFaces: TimedFace[],
  sceneCuts: number[] = []
): void {
  const sampleTimes = timedFaces.map(tf => tf.time).sort((a, b) => a - b)

  for (const ov of overrides) {
    const segIdx = segments.findIndex(s => s.start <= ov.time && ov.time < s.end)
    if (segIdx === -1) continue

    const seg = segments[segIdx]
    const params = manualSplitParams(ov, dims)

    let splitStart: number
    let splitEnd: number

    if (sceneCuts.length > 0) {
      // Snap boundaries to the scene cuts immediately before and after the marked frame.
      const cutBefore = [...sceneCuts].reverse().find(t => t < ov.time) ?? seg.start
      const cutAfter  = sceneCuts.find(t => t > ov.time) ?? seg.end
      splitStart = Math.max(seg.start, cutBefore)
      splitEnd   = Math.min(seg.end,   cutAfter)
    } else {
      // Fallback: midpoints to adjacent sampled frames, capped at ±2.5s
      const si = sampleTimes.reduce((best, t, i) =>
        Math.abs(t - ov.time) < Math.abs(sampleTimes[best] - ov.time) ? i : best, 0)
      const MAX_RADIUS = 2.5
      const prevMid = si > 0 ? (sampleTimes[si - 1] + sampleTimes[si]) / 2 : seg.start
      const nextMid = si < sampleTimes.length - 1 ? (sampleTimes[si] + sampleTimes[si + 1]) / 2 : seg.end
      splitStart = Math.max(seg.start, Math.max(prevMid, ov.time - MAX_RADIUS))
      splitEnd   = Math.min(seg.end,   Math.min(nextMid, ov.time + MAX_RADIUS))
    }

    const replacements: VideoSegment[] = []

    if (splitStart > seg.start) {
      replacements.push({
        ...seg,
        end: splitStart,
        timedFaces: seg.timedFaces.filter(tf => tf.time < splitStart),
      })
    }

    replacements.push({
      start: splitStart,
      end: splitEnd,
      type: 'split-screen',
      timedFaces: seg.timedFaces.filter(tf => tf.time >= splitStart && tf.time < splitEnd),
      manualSplitParams: params,
    })

    if (splitEnd < seg.end) {
      replacements.push({
        ...seg,
        start: splitEnd,
        timedFaces: seg.timedFaces.filter(tf => tf.time >= splitEnd),
      })
    }

    segments.splice(segIdx, 1, ...replacements)
  }
}
