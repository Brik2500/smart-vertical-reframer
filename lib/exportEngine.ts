import path from 'path'
import { TMP_DIR } from './videoUpload'
import { detectFacesOverTime, decideSplitScreen, getVideoDuration, TimedFace, FrameDimensions } from './faceDetection'
import { classifySegments, renderVideoWithSegments, VideoSegment } from './segmentEngine'
import { SplitScreenParams } from './splitScreenEngine'
import { computeSmartCrop } from './cropEngine'
import type { SampledFrame } from './jobStore'
import type { ManualKeyframe } from './cropEngine'

export type ReframingMode = 'smart-crop' | 'split-screen' | 'auto'

export async function detectVideo(
  jobId: string,
  inputPath: string
): Promise<{ timedFaces: TimedFace[]; dims: FrameDimensions; sampledFrames: SampledFrame[] }> {
  const { timedFaces, dims } = await detectFacesOverTime(inputPath, jobId, 12)

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

  return { timedFaces, dims, sampledFrames }
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
  splitOverrides: SplitOverride[] = []
): Promise<string> {
  const outputPath = path.join(TMP_DIR, `${jobId}_output.mp4`)
  const duration = getVideoDuration(inputPath)

  if (mode === 'split-screen') {
    const decision = decideSplitScreen(timedFaces, dims, 'split-screen')
    if (decision.useSplitScreen && decision.splitFaces) {
      const segments = [{ start: 0, end: duration, type: 'split-screen' as const, timedFaces, splitFaces: decision.splitFaces }]
      renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes)
      return outputPath
    }
  }

  if (mode === 'smart-crop') {
    const segments = [{ start: 0, end: duration, type: 'smart-crop' as const, timedFaces }]
    applyManualSplitScreens(segments, splitOverrides, dims)
    renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes)
    return outputPath
  }

  const segments = classifySegments(timedFaces, dims, duration)
  applyManualSplitScreens(segments, splitOverrides, dims)
  renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes)
  return outputPath
}

// Build SplitScreenParams from two manually positioned crop X values.
function manualSplitParams(ov: SplitOverride, dims: FrameDimensions): SplitScreenParams {
  const halfH = dims.height / 2
  const stripW = Math.floor((halfH * 9) / 16)
  const clamp = (x: number) => Math.max(0, Math.min(dims.width - stripW, x))
  return {
    top:    { x: clamp(ov.cropX),  y: 0,             width: stripW, height: Math.floor(halfH) },
    bottom: { x: clamp(ov.cropX2), y: Math.floor(halfH), width: stripW, height: dims.height - Math.floor(halfH) },
  }
}

// For each manual split-screen override, find the containing segment and
// upgrade it to split-screen using the user-positioned crop boxes.
function applyManualSplitScreens(
  segments: VideoSegment[],
  overrides: SplitOverride[],
  dims: FrameDimensions
): void {
  for (const ov of overrides) {
    const idx = segments.findIndex(s => s.start <= ov.time && ov.time < s.end)
    if (idx === -1) continue
    segments[idx] = {
      ...segments[idx],
      type: 'split-screen',
      manualSplitParams: manualSplitParams(ov, dims),
    }
  }
}
