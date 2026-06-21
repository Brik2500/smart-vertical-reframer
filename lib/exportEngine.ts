import path from 'path'
import { TMP_DIR } from './videoUpload'
import { detectFacesOverTime, decideSplitScreen, getVideoDuration, TimedFace, FrameDimensions } from './faceDetection'
import { classifySegments, renderVideoWithSegments } from './segmentEngine'
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

export async function renderVideo(
  jobId: string,
  inputPath: string,
  mode: ReframingMode,
  dims: FrameDimensions,
  timedFaces: TimedFace[],
  manualKeyframes: ManualKeyframe[] = [],
  splitScreenTimes: number[] = []
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
    applyManualSplitScreens(segments, splitScreenTimes, timedFaces)
    renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes)
    return outputPath
  }

  const segments = classifySegments(timedFaces, dims, duration)
  applyManualSplitScreens(segments, splitScreenTimes, timedFaces)
  renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes)
  return outputPath
}

// For each manually marked split-screen timestamp, find the containing segment
// and upgrade it to split-screen using the detected face positions.
function applyManualSplitScreens(
  segments: import('./segmentEngine').VideoSegment[],
  times: number[],
  timedFaces: TimedFace[]
): void {
  for (const t of times) {
    const tf = timedFaces.find(f => Math.abs(f.time - t) < 1.5)
    if (!tf || tf.faces.length < 2) continue
    const idx = segments.findIndex(s => s.start <= t && t < s.end)
    if (idx === -1) continue
    segments[idx] = { ...segments[idx], type: 'split-screen', splitFaces: [tf.faces[0], tf.faces[1]] }
  }
}
