import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import OpenAI from 'openai'
import { TMP_DIR } from './videoUpload'

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

export async function transcribeVideo(
  inputPath: string,
  jobId: string
): Promise<TranscriptSegment[]> {
  if (!process.env.OPENAI_API_KEY) {
    console.log('[transcribe] no OPENAI_API_KEY — skipping')
    return []
  }

  const ffmpegBin = require('ffmpeg-static') as string
  const audioPath = path.join(TMP_DIR, `${jobId}_audio.mp3`)

  try {
    // Extract audio as low-bitrate mono MP3 — sufficient for speech recognition
    // and keeps the file well under the Whisper API's 25MB limit.
    // A 30-min clip at these settings is ~7MB.
    execFileSync(ffmpegBin, [
      '-i', inputPath,
      '-vn',          // drop video
      '-ar', '16000', // 16kHz sample rate
      '-ac', '1',     // mono
      '-b:a', '32k',  // 32kbps — plenty for speech
      audioPath, '-y',
    ], { stdio: 'pipe' })

    const client = new OpenAI()
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    })

    const segments: TranscriptSegment[] = ((response as any).segments ?? []).map(
      (s: { start: number; end: number; text: string }) => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
      })
    )

    console.log(`[transcribe] ${segments.length} segment(s) from Whisper`)
    return segments
  } catch (err) {
    console.error('[transcribe] failed — continuing without transcript:', err)
    return []
  } finally {
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)
  }
}

// Returns the transcript segment whose window contains t, or the nearest one
// within 2s if t falls in a gap (pause between sentences).
export function findDialogueAtTime(
  segments: TranscriptSegment[],
  t: number
): string | undefined {
  // Exact match — t falls inside a segment
  const exact = segments.find(s => t >= s.start && t <= s.end)
  if (exact) return exact.text

  // Nearest within 2s — handles pauses between sentences
  let best: TranscriptSegment | undefined
  let bestDist = 2.0
  for (const s of segments) {
    const dist = Math.min(Math.abs(t - s.start), Math.abs(t - s.end))
    if (dist < bestDist) { bestDist = dist; best = s }
  }
  return best?.text
}
