import { NextResponse } from 'next/server'
import { getAllCorrections, getCorrectionCount } from '@/lib/correctionsStore'

export async function GET() {
  const corrections = getAllCorrections()
  return NextResponse.json({
    count: corrections.length,
    corrections,
  })
}
