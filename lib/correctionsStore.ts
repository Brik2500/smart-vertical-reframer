import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { DetectionType } from './faceDetection'

export interface CorrectionEntry {
  id: string
  jobId: string
  timestamp: number        // seconds into video
  frameW: number
  frameH: number
  cropW: number
  suggestedCropX: number   // AI's detected position
  correctedCropX: number   // Director's manual adjustment
  detectionType: DetectionType
  mode: string
  createdAt: string
}

const CORRECTIONS_FILE = path.join(os.tmpdir(), 'svr-corrections.jsonl')

export function saveCorrections(entries: Omit<CorrectionEntry, 'id' | 'createdAt'>[]) {
  const lines = entries
    .filter(e => e.suggestedCropX !== e.correctedCropX) // only save actual changes
    .map(e => JSON.stringify({
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...e,
    }))
    .join('\n')

  if (!lines) return

  fs.appendFileSync(CORRECTIONS_FILE, lines + '\n', 'utf8')
  console.log(`[corrections] saved ${lines.split('\n').length} correction(s)`)
}

export function getAllCorrections(): CorrectionEntry[] {
  if (!fs.existsSync(CORRECTIONS_FILE)) return []
  return fs.readFileSync(CORRECTIONS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as CorrectionEntry)
}

export function getCorrectionCount(): number {
  return getAllCorrections().length
}
