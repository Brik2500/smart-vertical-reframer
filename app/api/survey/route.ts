import { NextRequest, NextResponse } from 'next/server'
import { logEvent } from '@/lib/analytics'

interface SurveyPayload {
  jobId: string
  rating: number | null
  tags: string[]
  wouldUseAgain: boolean | null
  freeText?: string
}

export async function POST(req: NextRequest) {
  try {
    const { jobId, rating, tags, wouldUseAgain, freeText }: SurveyPayload = await req.json()

    logEvent({
      event: 'survey_submitted',
      jobId,
      rating,
      tags,
      wouldUseAgain,
      freeText: freeText?.trim() || undefined,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[survey]', err)
    return NextResponse.json({ error: 'Failed to save survey' }, { status: 500 })
  }
}
