export interface AnalyticsEvent {
  event: string
  jobId?: string
  [key: string]: unknown
}

export function logEvent(data: AnalyticsEvent): void {
  console.log(JSON.stringify({ _evt: true, ts: new Date().toISOString(), ...data }))
}
