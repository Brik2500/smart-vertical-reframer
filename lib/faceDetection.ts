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

export type DetectionType = 'face' | 'object' | 'saliency' | 'center'

export interface TimedFace {
  time: number
  faces: FaceBox[]
  detectionType: DetectionType
}

let faceapi: typeof import('@vladmandic/face-api') | null = null
let modelsLoaded = false
let cocoSsdModel: import('@tensorflow-models/coco-ssd').ObjectDetection | null = null

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

async function getCocoSsd() {
  if (!cocoSsdModel) {
    await import('@tensorflow/tfjs')
    const cocoSsd = await import('@tensorflow-models/coco-ssd')
    cocoSsdModel = await cocoSsd.load()
  }
  return cocoSsdModel
}

// Finds the crop window with highest visual activity (text, graphics, high-contrast content).
// Uses column luminance variance — text creates sharp dark/light alternations that
// score high even when no ML model recognizes the content.
async function detectSaliencyCenter(imagePath: string): Promise<FaceBox | null> {
  const { loadImage, createCanvas } = await import('canvas')
  const img = await loadImage(imagePath)

  // Work at 25% resolution for speed
  const scale = 0.25
  const w = Math.max(1, Math.floor(img.width * scale))
  const h = Math.max(1, Math.floor(img.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, w, h)

  const { data } = ctx.getImageData(0, 0, w, h)

  // Variance per column (text = high variance)
  const colVar = Array.from({ length: w }, (_, x) => {
    const vals: number[] = []
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      vals.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    return vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length
  })

  // Sliding window: find the column range whose variance sum is highest
  const cropW = Math.floor(w * 9 / 16)
  let bestScore = -1
  let bestCenterX = img.width / 2

  for (let startX = 0; startX + cropW <= w; startX++) {
    const score = colVar.slice(startX, startX + cropW).reduce((a, b) => a + b, 0)
    if (score > bestScore) {
      bestScore = score
      bestCenterX = ((startX + cropW / 2) / w) * img.width
    }
  }

  console.log(`[DEBUG] saliency fallback → centerX=${Math.round(bestCenterX)}`)

  const cropH = img.height
  const cropWFull = Math.floor((cropH * 9) / 16)
  const x = Math.max(0, Math.min(img.width - cropWFull, Math.floor(bestCenterX - cropWFull / 2)))
  return { x, y: 0, width: cropWFull, height: cropH, centerX: bestCenterX, centerY: img.height / 2, area: cropWFull * cropH }
}

async function detectSalientObject(imagePath: string): Promise<FaceBox | null> {
  const model = await getCocoSsd()
  const { loadImage, createCanvas } = await import('canvas')

  const img = await loadImage(imagePath)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)

  const predictions = await model.detect(canvas as never)
  if (predictions.length === 0) return null

  // Filter out tiny detections (< 3% of frame area) then take highest-scoring
  const frameArea = img.width * img.height
  const valid = predictions
    .filter(p => p.bbox[2] * p.bbox[3] >= frameArea * 0.03)
    .sort((a, b) => b.score - a.score)

  if (valid.length === 0) return null

  const [x, y, width, height] = valid[0].bbox
  console.log(`[DEBUG] object fallback → ${valid[0].class} (${(valid[0].score * 100).toFixed(0)}%) cx=${Math.round(x + width / 2)}`)
  return {
    x, y, width, height,
    centerX: x + width / 2,
    centerY: y + height / 2,
    area: width * height,
  }
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

// Laplacian variance — measures sharpness of a face crop region.
// Sharp (in-focus) faces have high edge energy; blurry ones are low.
// Used to rank faces when multiple are detected (rack focus shots).
function faceSharpness(
  imageData: { data: Uint8ClampedArray; width: number; height: number },
  face: FaceBox
): number {
  const { data, width } = imageData
  const x0 = Math.max(1, Math.floor(face.x))
  const y0 = Math.max(1, Math.floor(face.y))
  const x1 = Math.min(width - 2, Math.floor(face.x + face.width))
  const y1 = Math.min(imageData.height - 2, Math.floor(face.y + face.height))

  let sum = 0
  let count = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      const gray = (px: number) => {
        const j = px * 4
        return 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
      }
      // Laplacian kernel: center*4 - top - bottom - left - right
      const lap = 4 * gray(y * width + x)
        - gray((y - 1) * width + x)
        - gray((y + 1) * width + x)
        - gray(y * width + (x - 1))
        - gray(y * width + (x + 1))
      sum += lap * lap
      count++
    }
  }
  return count > 0 ? sum / count : 0
}

interface RawDetection {
  score: number
  box: { x: number; y: number; width: number; height: number }
  centerX: number
  centerY: number
  area: number
  filteredOut: boolean
  filterReason?: string
}

async function detectFacesInFrame(imagePath: string): Promise<{ faces: FaceBox[]; type: DetectionType; rawDetections: RawDetection[] }> {
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
  const minWidth = frameWidth * 0.03
  const edgeMargin = frameWidth * 0.03

  const imageData = ctx.getImageData(0, 0, img.width, img.height)

  const rawDetections: RawDetection[] = detections.map(d => {
    const cx = d.box.x + d.box.width / 2
    let filteredOut = false
    let filterReason: string | undefined
    if (d.box.width < minWidth) { filteredOut = true; filterReason = 'too_small' }
    else if (cx <= edgeMargin) { filteredOut = true; filterReason = 'too_far_left' }
    else if (cx >= frameWidth - edgeMargin) { filteredOut = true; filterReason = 'too_far_right' }
    return {
      score: d.score,
      box: { x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height },
      centerX: cx,
      centerY: d.box.y + d.box.height / 2,
      area: d.box.width * d.box.height,
      filteredOut,
      filterReason,
    }
  })

  const faces = detections
    .filter(d => {
      const cx = d.box.x + d.box.width / 2
      return d.box.width >= minWidth && cx > edgeMargin && cx < frameWidth - edgeMargin
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

  if (faces.length > 1) {
    const scored = faces.map(f => ({ f, s: faceSharpness(imageData, f) }))
    scored.sort((a, b) => b.s - a.s)
    console.log(`[DEBUG] sharpness scores: ${scored.map(x => Math.round(x.s)).join(' | ')} → leading with cx=${Math.round(scored[0].f.centerX)}`)
    return { faces: scored.map(x => x.f), type: 'face' as DetectionType, rawDetections }
  }

  if (faces.length > 0) return { faces, type: 'face' as DetectionType, rawDetections }

  const obj = await detectSalientObject(imagePath)
  if (obj) return { faces: [obj], type: 'object' as DetectionType, rawDetections }

  const sal = await detectSaliencyCenter(imagePath)
  if (sal) return { faces: [sal], type: 'saliency' as DetectionType, rawDetections }

  return { faces: [], type: 'center' as DetectionType, rawDetections }
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
  const detectionLog: Array<{ t: number; type: DetectionType; raw: RawDetection[] }> = []

  for (const t of timestamps) {
    const framePath = path.join(frameDir, `frame_t${t.toFixed(2).replace('.', '_')}.jpg`)
    try {
      extractFrameAt(videoPath, t, framePath)
      const { faces, type, rawDetections } = await detectFacesInFrame(framePath)
      faces.sort((a, b) => b.area - a.area)
      console.log(`[DEBUG] t=${t}s → ${faces.length} face(s) [${type}]`, faces.map(f =>
        `cx=${Math.round(f.centerX)} w=${Math.round(f.width)}`
      ).join(' | '))
      detectionLog.push({ t, type, raw: rawDetections })
      timedFaces.push({ time: t, faces, detectionType: type })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const spawnErr = err as { stderr?: Buffer }
      const ffmpegErr = spawnErr?.stderr ? spawnErr.stderr.toString().slice(-300) : ''
      console.log(`[DEBUG] t=${t}s → frame extraction failed: ${msg}`)
      if (ffmpegErr) console.log(`[DEBUG] ffmpeg stderr: ${ffmpegErr}`)
      detectionLog.push({ t, type: 'center', raw: [] })
      timedFaces.push({ time: t, faces: [], detectionType: 'center' })
    }
  }

  // Write raw detection log for post-hoc diagnosis of glitch frames.
  // Download via /api/detections?jobId=<id> to inspect confidence scores
  // and bounding boxes before/after filtering.
  const logPath = path.join(TMP_DIR, `${jobId}_detections.json`)
  fs.writeFileSync(logPath, JSON.stringify(detectionLog, null, 2))
  console.log(`[detect] raw detection log → ${logPath}`)

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
