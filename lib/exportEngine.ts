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
  manualKeyframes: ManualKeyframe[] = []
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
    renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes)
    return outputPath
  }

  const segments = classifySegments(timedFaces, dims, duration)
  renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath, manualKeyframes)
  return outputPath
}
