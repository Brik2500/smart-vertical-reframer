import { spawnSync } from 'child_process'

function ffmpegBin(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ffmpeg-static') as string
}

// Returns timestamps (seconds) of scene cuts detected in the video.
// Uses FFmpeg's scene filter (select=gt(scene\,threshold)) — the comma
// inside gt() must be backslash-escaped so FFmpeg doesn't split it as
// a filter separator. threshold 0.30 catches hard cuts and jump cuts;
// lower to ~0.15 to also catch soft dissolves.
export function detectSceneCuts(inputPath: string, threshold = 0.30): number[] {
  const ffmpeg = ffmpegBin()

  // Note: the comma in gt(scene\,threshold) is escaped with \ so FFmpeg's
  // filter-graph parser treats it as part of the expression, not a filter separator.
  const result = spawnSync(ffmpeg, [
    '-i', inputPath,
    '-vf', `select=gt(scene\\,${threshold}),metadata=print`,
    '-an',
    '-f', 'null',
    '-',
  ], { maxBuffer: 50 * 1024 * 1024 })

  // metadata=print writes to stderr; combine both to be safe
  const output = [
    result.stdout?.toString('utf8') ?? '',
    result.stderr?.toString('utf8') ?? '',
  ].join('\n')

  const times: number[] = []
  for (const line of output.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/)
    if (m) times.push(parseFloat(m[1]))
  }

  console.log(`[scenes] threshold=${threshold} → ${times.length} cut(s): ${times.map(t => t.toFixed(2)).join(', ')}`)
  return times.sort((a, b) => a - b)
}
