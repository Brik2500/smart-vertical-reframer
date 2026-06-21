import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { TMP_DIR } from '@/lib/videoUpload'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ jobId: string; filename: string }> }
) {
  const { jobId, filename } = await params
  const filePath = path.join(TMP_DIR, `${jobId}_frames`, filename)

  if (!fs.existsSync(filePath)) {
    return new NextResponse('Not found', { status: 404 })
  }

  const buffer = fs.readFileSync(filePath)
  return new NextResponse(buffer, {
    headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' },
  })
}
