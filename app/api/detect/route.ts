import { NextRequest, NextResponse } from 'next/server'
import { getJob, updateJob } from '@/lib/jobStore'
import { detectVideo } from '@/lib/exportEngine'

export async function POST(req: NextRequest) {
  try {
    const { jobId } = await req.json()
    const job = getJob(jobId)

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    if (job.status !== 'pending') return NextResponse.json({ error: 'Job already started' }, { status: 400 })

    updateJob(jobId, { status: 'detecting' })

    detectVideo(jobId, job.inputPath)
      .then(({ timedFaces, dims, sampledFrames, sceneCuts }) => {
        updateJob(jobId, { status: 'review', timedFaces, dims, sampledFrames, sceneCuts })
      })
      .catch(err => {
        console.error('[detect]', err)
        updateJob(jobId, { status: 'error', error: String(err) })
      })

    return NextResponse.json({ status: 'detecting' })
  } catch (err) {
    console.error('[detect]', err)
    return NextResponse.json({ error: 'Failed to start detection' }, { status: 500 })
  }
}
