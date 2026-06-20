export type JobStatus = 'pending' | 'processing' | 'done' | 'error'

export interface Job {
  id: string
  status: JobStatus
  inputPath: string
  outputPath?: string
  error?: string
  mode: string
  createdAt: number
}

// In-memory store — sufficient for V1 single-server use
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
