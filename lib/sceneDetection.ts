import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

function ffmpegBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ffmpeg-static') as string
}

// Returns timestamps (seconds) of scene cuts detected in the video.
// Uses FFmpeg's scene filter — threshold 0.35 catches hard cuts and
// most dissolves without triggering on minor motion.
export function detectSceneCuts(inputPath: string, threshold = 0.35): number[] {
  const ffmpeg = ffmpegBin()
  const tmpFile = path.join(os.tmpdir(), `svr_scenes_${Date.now()}.txt`)

  try {
    execFileSync(ffmpeg, [
      '-loglevel', 'error',
      '-i', inputPath,
      '-vf', `select=gt(scene,${threshold}),metadata=print:file=${tmpFile}`,
      '-vsync', 'vfr',
      '-an',
      '-f', 'null',
      '-',
    ], { stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 })
  } catch {
    // FFmpeg exits 0 on success but some versions throw — read file if it exists
  }

  if (!fs.existsSync(tmpFile)) return []

  const output = fs.readFileSync(tmpFile, 'utf8')
  fs.unlinkSync(tmpFile)

  // Each detected frame has a line like: "frame:N   pts:XXX  pts_time:5.144000"
  const times: number[] = []
  for (const line of output.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/)
    if (m) times.push(parseFloat(m[1]))
  }

  return times.sort((a, b) => a - b)
}
