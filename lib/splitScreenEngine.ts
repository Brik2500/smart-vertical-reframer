import { FaceBox, FrameDimensions } from './faceDetection'

export interface SplitScreenParams {
  top: { x: number; y: number; width: number; height: number }
  bottom: { x: number; y: number; width: number; height: number }
}

// Each person gets half the vertical 9:16 output.
// We crop a portrait strip around each face from the original frame.
export function computeSplitScreen(
  faceA: FaceBox,
  faceB: FaceBox,
  dims: FrameDimensions
): SplitScreenParams {
  // Output will be 1080x1920. Each half = 1080x960.
  // Source crop for each half: 9:16 ratio of the half height
  // Half height in source coords = dims.height / 2
  const halfH = dims.height / 2
  // Width of a 9:16 strip at halfH height (but we use full output width mapping)
  // We keep full source height halves and crop a portrait strip
  const stripW = Math.floor((halfH * 9) / 16)

  function clampX(centerX: number): number {
    return Math.max(0, Math.min(dims.width - stripW, Math.floor(centerX - stripW / 2)))
  }

  // Sort: top = face with smaller centerY (higher in frame)
  const [topFace, bottomFace] = faceA.centerY <= faceB.centerY
    ? [faceA, faceB]
    : [faceB, faceA]

  return {
    top: {
      x: clampX(topFace.centerX),
      y: 0,
      width: stripW,
      height: Math.floor(halfH),
    },
    bottom: {
      x: clampX(bottomFace.centerX),
      y: Math.floor(halfH),
      width: stripW,
      height: dims.height - Math.floor(halfH),
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
