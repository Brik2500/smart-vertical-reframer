import path from 'path'
import fs from 'fs'
import { execFileSync } from 'child_process'
import { TMP_DIR } from './videoUpload'

export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
  centerX: number
  centerY: number
  area: number
}

export interface FrameDimensions {
  width: number
  height: number
}

export interface TimedFace {
  time: number       // seconds into video
  faces: FaceBox[]
}

let faceapi: typeof import('@vladmandic/face-api') | null = null
let modelsLoaded = false

async function getFaceApi() {
  if (!faceapi) {
    await import('@tensorflow/tfjs')
    faceapi = await import('@vladmandic/face-api')
    const { Canvas, Image, ImageData } = await import('canvas')
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData } as never)
  }
  return faceapi
}

async function loadModels() {
  if (modelsLoaded) return
  const api = await getFaceApi()
  const modelPath = path.join(process.cwd(), 'node_modules/@vladmandic/face-api/model')
  await api.nets.ssdMobilenetv1.loadFromDisk(modelPath)
  modelsLoaded = true
}

function ffmpegBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ffmpeg-static') as string
}

function ffprobeBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('ffprobe-static') as { path: string }).path
}

export function getVideoDuration(videoPath: string): number {
  const result = execFileSync(ffprobeBin(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration',
    '-of', 'csv=p=0',
    videoPath,
  ], { encoding: 'utf8' }).trim()
  return parseFloat(result) || 0
}

export function getVideoDimensions(videoPath: string): FrameDimensions {
  const result = execFileSync(ffprobeBin(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0',
    videoPath,
  ], { encoding: 'utf8' }).trim()
  const [width, height] = result.split('x').map(Number)
  return { width, height }
}

// Extract one frame at a specific timestamp (seconds)
function extractFrameAt(videoPath: string, timestamp: number, outputPath: string) {
  execFileSync(ffmpegBin(), [
    '-ss', String(timestamp),
    '-i', videoPath,
    '-vframes', '1',
    '-q:v', '3',
    '-update', '1',   // required by newer ffmpeg to write a single image (not a sequence)
    outputPath,
    '-y',
  ], { stdio: 'pipe' })
}

async function detectFacesInFrame(imagePath: string): Promise<FaceBox[]> {
  await loadModels()
  const api = await getFaceApi()
  const { loadImage, createCanvas } = await import('canvas')

  const img = await loadImage(imagePath)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)

  // Lower confidence threshold (default 0.5) to catch faces that are:
  // - small in wide/two-shots
  // - at a 3/4 angle (looking across the room at another person)
  // The edge/size filters below still reject noise at this lower threshold.
  const detections = await api.detectAllFaces(
    canvas as never,
    new api.SsdMobilenetv1Options({ minConfidence: 0.3 })
  )
  const frameWidth = img.width

  return detections
    .filter(d => {
      // Reject truly partial faces at the extreme edges.
      // Minimum width is 3% of frame — low enough to catch wide two-shots
      // where both faces are small, but high enough to reject pixel noise.
      // Edge margin rejects faces whose CENTER is within 3% of the frame edge
      // (these are almost always cut-off partial bodies, not real subjects).
      const minWidth = frameWidth * 0.03
      const edgeMargin = frameWidth * 0.03
      const centerX = d.box.x + d.box.width / 2
      return d.box.width >= minWidth &&
        centerX > edgeMargin &&
        centerX < frameWidth - edgeMargin
    })
    .map(d => ({
      x: d.box.x,
      y: d.box.y,
      width: d.box.width,
      height: d.box.height,
      centerX: d.box.x + d.box.width / 2,
      centerY: d.box.y + d.box.height / 2,
      area: d.box.width * d.box.height,
    }))
}

// Sample the video at evenly spaced timestamps, returning faces per timestamp
export async function detectFacesOverTime(
  videoPath: string,
  jobId: string,
  sampleCount = 8
): Promise<{ timedFaces: TimedFace[]; dims: FrameDimensions }> {
  const dims = getVideoDimensions(videoPath)
  const duration = getVideoDuration(videoPath)
  const frameDir = path.join(TMP_DIR, `${jobId}_frames`)
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true })

  // Spread samples across the video, avoiding the very first/last frame
  const step = duration / (sampleCount + 1)
  const timestamps = Array.from({ length: sampleCount }, (_, i) => parseFloat(((i + 1) * step).toFixed(2)))

  const timedFaces: TimedFace[] = []

  for (const t of timestamps) {
    const framePath = path.join(frameDir, `frame_t${t.toFixed(2).replace('.', '_')}.jpg`)
    try {
      extractFrameAt(videoPath, t, framePath)
      const faces = await detectFacesInFrame(framePath)
      faces.sort((a, b) => b.area - a.area)
      console.log(`[DEBUG] t=${t}s → ${faces.length} face(s)`, faces.map(f =>
        `cx=${Math.round(f.centerX)} w=${Math.round(f.width)}`
      ).join(' | '))
      timedFaces.push({ time: t, faces })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // execFileSync throws a SpawnSyncReturns — its stderr is the real FFmpeg error
      const spawnErr = err as { stderr?: Buffer }
      const ffmpegErr = spawnErr?.stderr ? spawnErr.stderr.toString().slice(-300) : ''
      console.log(`[DEBUG] t=${t}s → frame extraction failed: ${msg}`)
      if (ffmpegErr) console.log(`[DEBUG] ffmpeg stderr: ${ffmpegErr}`)
    }
  }

  return { timedFaces, dims }
}

export interface SplitDecision {
  useSplitScreen: boolean
  // The two co-present faces to use for split layout (only set when useSplitScreen=true)
  splitFaces?: [FaceBox, FaceBox]
  // Primary face for smart crop
  primaryFace?: FaceBox
}

// Implements Chat's rule:
// "IF two faces are simultaneously visible AND span >50% of frame width
//  AND both appear in multiple frames (neither dominates)
//  THEN recommend split screen"
//
// This checks co-presence PER FRAME — not across frames.
// Two people alternating in close-ups won't trigger split screen.
// Two people simultaneously visible in a two-shot will.
export function decideSplitScreen(
  timedFaces: TimedFace[],
  dims: FrameDimensions,
  requestedMode: string
): SplitDecision {
  if (requestedMode === 'smart-crop') {
    const primary = primaryFaceFromFrames(timedFaces)
    return { useSplitScreen: false, primaryFace: primary ?? undefined }
  }

  // Find frames where two faces are co-present and span >50% of frame width
  const twoFaceFrames: Array<{ faceA: FaceBox; faceB: FaceBox }> = []

  for (const tf of timedFaces) {
    if (tf.faces.length < 2) continue
    const a = tf.faces[0]
    const b = tf.faces[1]
    const leftEdge = Math.min(a.x, b.x)
    const rightEdge = Math.max(a.x + a.width, b.x + b.width)
    const combinedSpan = rightEdge - leftEdge
    if (combinedSpan > dims.width * 0.50) {
      twoFaceFrames.push({ faceA: a, faceB: b })
    }
  }

  const avgFace = (faces: FaceBox[]): FaceBox => {
    const avg = (key: keyof FaceBox) =>
      faces.reduce((s, f) => s + (f[key] as number), 0) / faces.length
    return { x: avg('x'), y: avg('y'), width: avg('width'), height: avg('height'),
             centerX: avg('centerX'), centerY: avg('centerY'), area: avg('area') }
  }

  // Auto mode: Chat's rule — only split when two faces are co-present in frame
  if (twoFaceFrames.length >= 2) {
    const faceA = avgFace(twoFaceFrames.map(f => f.faceA))
    const faceB = avgFace(twoFaceFrames.map(f => f.faceB))
    return { useSplitScreen: true, splitFaces: [faceA, faceB] }
  }

  // Forced split-screen mode: user explicitly chose it.
  // Even if the two subjects appear in alternating shots (never together),
  // build the layout using the two most spatially distinct faces seen across the video.
  if (requestedMode === 'split-screen') {
    const twoSubjects = findTwoDistinctSubjects(timedFaces, dims)
    if (twoSubjects) {
      return { useSplitScreen: true, splitFaces: twoSubjects }
    }
  }

  // Default: smart crop on the most prominent face seen across frames
  const primary = primaryFaceFromFrames(timedFaces)
  return { useSplitScreen: false, primaryFace: primary ?? undefined }
}

// For forced split-screen on alternating-subject footage:
// Cluster all detected faces by horizontal position, take the two most
// spatially distinct clusters as the two subjects.
function findTwoDistinctSubjects(
  timedFaces: TimedFace[],
  dims: FrameDimensions
): [FaceBox, FaceBox] | null {
  const allFaces = timedFaces.flatMap(tf => tf.faces)
  if (allFaces.length < 2) return null

  const threshold = dims.width * 0.25
  const clusters: FaceBox[][] = []

  for (const face of allFaces) {
    const existing = clusters.find(c =>
      Math.abs(c[0].centerX - face.centerX) < threshold
    )
    if (existing) existing.push(face)
    else clusters.push([face])
  }

  if (clusters.length < 2) return null

  // Average each cluster, sort by area (prominence), take the two largest
  const avg = (arr: FaceBox[], key: keyof FaceBox) =>
    arr.reduce((s, f) => s + (f[key] as number), 0) / arr.length

  const averaged = clusters
    .map(c => ({
      x: avg(c, 'x'), y: avg(c, 'y'), width: avg(c, 'width'), height: avg(c, 'height'),
      centerX: avg(c, 'centerX'), centerY: avg(c, 'centerY'), area: avg(c, 'area'),
    }))
    .sort((a, b) => b.area - a.area)

  return [averaged[0], averaged[1]]
}

function primaryFaceFromFrames(timedFaces: TimedFace[]): FaceBox | null {
  // Pick the largest face seen across all frames (most screen-prominent subject)
  let best: FaceBox | null = null
  for (const tf of timedFaces) {
    const f = tf.faces[0]
    if (f && (!best || f.area > best.area)) best = f
  }
  return best
}
