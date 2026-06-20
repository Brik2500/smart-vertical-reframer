import path from 'path'
import { TMP_DIR } from './videoUpload'
import { detectFacesOverTime, decideSplitScreen, getVideoDuration } from './faceDetection'
import { classifySegments, renderVideoWithSegments } from './segmentEngine'

export type ReframingMode = 'smart-crop' | 'split-screen' | 'auto'

export async function processVideo(
  jobId: string,
  inputPath: string,
  mode: ReframingMode
): Promise<string> {
  const outputPath = path.join(TMP_DIR, `${jobId}_output.mp4`)

  const { timedFaces, dims } = await detectFacesOverTime(inputPath, jobId, 12)
  const duration = getVideoDuration(inputPath)

  if (mode === 'split-screen') {
    // Forced whole-video split screen: use temporal clustering to find two subjects
    const decision = decideSplitScreen(timedFaces, dims, 'split-screen')
    if (decision.useSplitScreen && decision.splitFaces) {
      const segments = [{
        start: 0,
        end: duration,
        type: 'split-screen' as const,
        timedFaces,
        splitFaces: decision.splitFaces,
      }]
      renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath)
      return outputPath
    }
    // No two subjects found — fall through to smart crop
  }

  if (mode === 'smart-crop') {
    // Forced single-subject smart crop for whole video
    const segments = [{ start: 0, end: duration, type: 'smart-crop' as const, timedFaces }]
    renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath)
    return outputPath
  }

  // Auto mode: classify timeline into segments by shot type.
  // Single-person shots → Smart Crop. Two-shot moments → Split Screen.
  // The crop switches as the shot type changes.
  const segments = classifySegments(timedFaces, dims, duration)
  renderVideoWithSegments(inputPath, segments, dims, jobId, outputPath)
  return outputPath
}
