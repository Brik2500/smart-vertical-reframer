import type { TimedFace, FrameDimensions, DetectionType } from './faceDetection'

export type JobStatus = 'pending' | 'detecting' | 'review' | 'rendering' | 'done' | 'error'

export interface SampledFrame {
  time: number
  filename: string       // relative filename inside {jobId}_frames/
  frameW: number
  frameH: number
  cropX: number          // AI-suggested left edge of crop (frame pixels)
  cropW: number
  detectionType: DetectionType
  faceCount: number      // how many faces detected in this frame
  dialogue?: string      // nearest Whisper transcript line at this timestamp
}

export interface Job {
  id: string
  status: JobStatus
  inputPath: string
  outputPath?: string
  error?: string
  mode: string
  createdAt: number
  // populated after detection
  sampledFrames?: SampledFrame[]
  timedFaces?: TimedFace[]
  dims?: FrameDimensions
  sceneCuts?: number[]
}

const jobs = new Map<string, Job>()

export function createJob(id: string, inputPath: string, mode: string): Job {
  const job: Job = { id, status: 'pending', inputPath, mode, createdAt: Date.now() }
  jobs.set(id, job)
  return job
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id)
}

export function updateJob(id: string, updates: Partial<Job>) {
  const job = jobs.get(id)
  if (job) jobs.set(id, { ...job, ...updates })
}
