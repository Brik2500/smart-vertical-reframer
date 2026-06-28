import { classifyError } from './errorClassifier'

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL

export function notifyRenderSuccess(opts: {
  jobId: string
  durationSecs: number
  mode: string
  correctionCount: number
  renderTimeSecs: number
}): void {
  if (!WEBHOOK_URL) return
  const dur = Math.round(opts.durationSecs)
  const rt  = Math.round(opts.renderTimeSecs)
  const mode = opts.mode === 'auto' ? 'Auto' : opts.mode === 'smart-crop' ? 'Smart Crop' : 'Split Screen'
  const text = `✅ Render complete — ${dur}s video, ${mode}, ${opts.correctionCount} correction${opts.correctionCount !== 1 ? 's' : ''}, rendered in ${rt}s`
  postSlack(text)
}

export function notifyRenderFailure(opts: {
  jobId: string
  durationSecs?: number
  err: unknown
}): void {
  if (!WEBHOOK_URL) return
  const category = classifyError(opts.err)
  const durPart = opts.durationSecs != null ? `, ${Math.round(opts.durationSecs)}s video` : ''
  const text = `❌ Render failed — job ${opts.jobId}${durPart}, ${category}`
  postSlack(text)
}

function postSlack(text: string): void {
  if (!WEBHOOK_URL) return
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(err => console.error('[slack] notification failed (non-blocking):', err))
}
