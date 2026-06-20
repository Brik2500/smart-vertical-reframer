import { NextRequest, NextResponse } from 'next/server'
import { getJob } from '@/lib/jobStore'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = getJob(id)

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  return NextResponse.json({
    status: job.status,
    error: job.error,
  })
}
