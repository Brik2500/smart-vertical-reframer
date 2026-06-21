import { NextRequest, NextResponse } from 'next/server'
import { getJob, updateJob } from '@/lib/jobStore'
import { renderVideo, ReframingMode, SplitOverride } from '@/lib/exportEngine'
import { saveCorrections } from '@/lib/correctionsStore'
import type { SampledFrame } from '@/lib/jobStore'

interface Override {
  time: number
  cropX: number
  cropX2?: number
  splitScreen?: boolean
}

export async function POST(req: NextRequest) {
  try {
    const { jobId, overrides }: { jobId: string; overrides: Override[] } = await req.json()
    const job = getJob(jobId)

    if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    if (job.status !== 'review') return NextResponse.json({ error: 'Job not ready for render' }, { status: 400 })
    if (!job.timedFaces || !job.dims) return NextResponse.json({ error: 'Detection data missing' }, { status: 400 })

    // Save AI suggestion vs director correction pairs as training data
    if (job.sampledFrames && overrides.length > 0) {
      const corrections = overrides.map(ov => {
        const frame = job.sampledFrames!.find((f: SampledFrame) => Math.abs(f.time - ov.time) < 0.5)
        if (!frame) return null
        return {
          jobId,
          timestamp: ov.time,
          frameW: frame.frameW,
          frameH: frame.frameH,
          cropW: frame.cropW,
          suggestedCropX: frame.cropX,
          correctedCropX: ov.cropX,
          detectionType: frame.detectionType,
          mode: job.mode,
        }
      }).filter(Boolean) as Parameters<typeof saveCorrections>[0]

      saveCorrections(corrections)
    }

    updateJob(jobId, { status: 'rendering' })

    const manualKeyframes = overrides.filter(o => !o.splitScreen).map(o => ({ t: o.time, x: o.cropX }))
    const splitOverrides: SplitOverride[] = overrides
      .filter(o => o.splitScreen)
      .map(o => ({ time: o.time, cropX: o.cropX, cropX2: o.cropX2 ?? o.cropX }))
    renderVideo(jobId, job.inputPath, job.mode as ReframingMode, job.dims, job.timedFaces, manualKeyframes, splitOverrides)
      .then(outputPath => updateJob(jobId, { status: 'done', outputPath }))
      .catch(err => {
        console.error('[render]', err)
        updateJob(jobId, { status: 'error', error: String(err) })
      })

    return NextResponse.json({ status: 'rendering' })
  } catch (err) {
    console.error('[render]', err)
    return NextResponse.json({ error: 'Failed to start render' }, { status: 500 })
  }
}
