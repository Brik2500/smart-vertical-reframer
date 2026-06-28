export type FailureCategory =
  | 'crop bounds error'
  | 'no faces detected'
  | 'timeout'
  | 'missing input file'
  | 'FFmpeg error'
  | 'unknown render failure'

export function classifyError(err: unknown): FailureCategory {
  const msg = String(err).toLowerCase()
  if (msg.includes('crop') && (msg.includes('invalid') || msg.includes('too big') || msg.includes('non positive'))) return 'crop bounds error'
  if (msg.includes('no faces') || msg.includes('no face')) return 'no faces detected'
  if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('etimedout')) return 'timeout'
  if (msg.includes('enoent') || msg.includes('no such file')) return 'missing input file'
  if (msg.includes('ffmpeg') || msg.includes('execfile')) return 'FFmpeg error'
  return 'unknown render failure'
}

const USER_MESSAGES: Record<FailureCategory, string> = {
  'crop bounds error': "Something went wrong processing this video's framing. Please try again, or contact us if it keeps happening.",
  'no faces detected': "We couldn't detect any faces in this video — it may not be a good fit for auto-reframing yet.",
  'timeout': "Processing timed out. This sometimes happens with longer or complex videos — please try again.",
  'missing input file': "Processing failed — the video file could not be found. Please try again.",
  'FFmpeg error': "Something went wrong during processing. Please try again.",
  'unknown render failure': "Something went wrong during processing. Please try again.",
}

export function userFacingError(err: unknown): string {
  return USER_MESSAGES[classifyError(err)]
}
