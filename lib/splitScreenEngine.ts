import { FaceBox, FrameDimensions } from './faceDetection'

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

// For split screen, ffmpeg must use -filter_complex and map [out]
export function isSplitScreen(): boolean {
  return true
}
