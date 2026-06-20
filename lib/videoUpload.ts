import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

export const TMP_DIR = path.join(process.cwd(), 'tmp')

export function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  }
}

export async function saveUploadedVideo(file: File): Promise<{ jobId: string; inputPath: string }> {
  ensureTmpDir()
  const jobId = uuidv4()
  const ext = path.extname(file.name) || '.mp4'
  const inputPath = path.join(TMP_DIR, `${jobId}_input${ext}`)

  const buffer = Buffer.from(await file.arrayBuffer())
  fs.writeFileSync(inputPath, buffer)

  return { jobId, inputPath }
}
