import { NextRequest, NextResponse } from 'next/server'
import { saveUploadedVideo } from '@/lib/videoUpload'
import { createJob } from '@/lib/jobStore'
import { logEvent } from '@/lib/analytics'

const MAX_FILE_SIZE = 200 * 1024 * 1024 // 200 MB

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('video') as File | null
    const mode = (formData.get('mode') as string) || 'auto'
    const projectType = (formData.get('projectType') as string) || undefined

    if (!file) {
      return NextResponse.json({ error: 'No video file provided' }, { status: 400 })
    }

    if (file.size > MAX_FILE_SIZE) {
      const mb = (file.size / 1024 / 1024).toFixed(0)
      return NextResponse.json(
        { error: `This file is ${mb}MB — trial limit is 200MB. Try a lower bitrate export.` },
        { status: 413 }
      )
    }

    const { jobId, inputPath } = await saveUploadedVideo(file)
    createJob(jobId, inputPath, mode, projectType)

    logEvent({
      event: 'upload_completed',
      jobId,
      fileSizeMB: Math.round(file.size / 1024 / 1024),
      projectType,
      mode,
    })

    return NextResponse.json({ jobId })
  } catch (err) {
    console.error('[upload]', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
