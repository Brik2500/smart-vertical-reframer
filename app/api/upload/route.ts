import { NextRequest, NextResponse } from 'next/server'
import { saveUploadedVideo } from '@/lib/videoUpload'
import { createJob } from '@/lib/jobStore'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('video') as File | null
    const mode = (formData.get('mode') as string) || 'auto'

    if (!file) {
      return NextResponse.json({ error: 'No video file provided' }, { status: 400 })
    }

    const { jobId, inputPath } = await saveUploadedVideo(file)
    createJob(jobId, inputPath, mode)

    return NextResponse.json({ jobId })
  } catch (err) {
    console.error('[upload]', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
