import { NextRequest, NextResponse } from 'next/server'
import { getJob, updateJob } from '@/lib/jobStore'
import { processVideo, ReframingMode } from '@/lib/exportEngine'

export async function POST(req: NextRequest) {
  try {
    const { jobId } = await req.json()
    const job = getJob(jobId)

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    if (job.status !== 'pending') {
      return NextResponse.json({ error: 'Job already started' }, { status: 400 })
    }

    updateJob(jobId, { status: 'processing' })

    // Run async — don't await so the response returns immediately
    processVideo(jobId, job.inputPath, job.mode as ReframingMode)
      .then(outputPath => updateJob(jobId, { status: 'done', outputPath }))
      .catch(err => {
        console.error('[process]', err)
        updateJob(jobId, { status: 'error', error: String(err) })
      })

    return NextResponse.json({ status: 'processing' })
  } catch (err) {
    console.error('[process]', err)
    return NextResponse.json({ error: 'Failed to start processing' }, { status: 500 })
  }
}
