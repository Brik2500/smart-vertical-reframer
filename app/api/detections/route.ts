import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { TMP_DIR } from '@/lib/videoUpload'

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId')
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 })

  const logPath = path.join(TMP_DIR, `${jobId}_detections.json`)
  if (!fs.existsSync(logPath)) {
    return NextResponse.json({ error: 'Detection log not found — run detect first' }, { status: 404 })
  }

  const data = fs.readFileSync(logPath, 'utf8')
  return new NextResponse(data, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${jobId}_detections.json"`,
    },
  })
}
