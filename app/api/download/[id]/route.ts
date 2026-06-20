import { NextRequest, NextResponse } from 'next/server'
import { getJob } from '@/lib/jobStore'
import fs from 'fs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = getJob(id)

  if (!job || job.status !== 'done' || !job.outputPath) {
    return NextResponse.json({ error: 'Output not ready' }, { status: 404 })
  }

  if (!fs.existsSync(job.outputPath)) {
    return NextResponse.json({ error: 'Output file missing' }, { status: 404 })
  }

  const buffer = fs.readFileSync(job.outputPath)

  return new NextResponse(buffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': `attachment; filename="reframed_${id}.mp4"`,
      'Content-Length': String(buffer.length),
    },
  })
}
