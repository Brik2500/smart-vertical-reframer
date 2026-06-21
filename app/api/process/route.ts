import { NextResponse } from 'next/server'

// Superseded by /api/detect + /api/render
export async function POST() {
  return NextResponse.json({ error: 'Use /api/detect then /api/render' }, { status: 410 })
}
