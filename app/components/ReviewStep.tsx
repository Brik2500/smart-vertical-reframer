'use client'

import { useState, useRef, useCallback } from 'react'
import type { SampledFrame } from '@/lib/jobStore'

interface ReviewStepProps {
  jobId: string
  frames: SampledFrame[]
  onRender: (overrides: { time: number; cropX: number }[]) => void
}

const DETECTION_LABELS: Record<string, string> = {
  face: 'Face',
  object: 'Object',
  saliency: 'Text/Saliency',
  center: 'Center fallback',
}

const DETECTION_COLORS: Record<string, string> = {
  face: 'text-emerald-400',
  object: 'text-blue-400',
  saliency: 'text-yellow-400',
  center: 'text-zinc-500',
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const DISPLAY_W = 260

function FrameCard({
  frame,
  jobId,
  cropX,
  onChange,
}: {
  frame: SampledFrame
  jobId: string
  cropX: number
  onChange: (x: number) => void
}) {
  const displayH = Math.round(DISPLAY_W * frame.frameH / frame.frameW)
  const scale = DISPLAY_W / frame.frameW
  const displayCropX = cropX * scale
  const displayCropW = frame.cropW * scale
  const maxDisplayX = DISPLAY_W - displayCropW

  const isDragging = useRef(false)
  const dragStartClientX = useRef(0)
  const dragStartCropX = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    isDragging.current = true
    dragStartClientX.current = e.clientX
    dragStartCropX.current = cropX
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [cropX])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return
    const dx = (e.clientX - dragStartClientX.current) / scale
    const newX = Math.max(0, Math.min(frame.frameW - frame.cropW, dragStartCropX.current + dx))
    onChange(Math.round(newX))
  }, [scale, frame.frameW, frame.cropW, onChange])

  const onPointerUp = useCallback(() => {
    isDragging.current = false
  }, [])

  const isModified = Math.abs(cropX - frame.cropX) > 2

  return (
    <div className="space-y-1.5">
      <div
        className="relative overflow-hidden rounded-lg bg-zinc-900 select-none touch-none"
        style={{ width: DISPLAY_W, height: displayH }}
      >
        {/* Frame image */}
        <img
          src={`/api/frames/${jobId}/${frame.filename}`}
          alt={`Frame at ${formatTime(frame.time)}`}
          width={DISPLAY_W}
          height={displayH}
          className="absolute inset-0 object-cover pointer-events-none"
          draggable={false}
        />

        {/* Left dim */}
        <div
          className="absolute inset-y-0 left-0 bg-black/60 pointer-events-none"
          style={{ width: Math.max(0, displayCropX) }}
        />

        {/* Right dim */}
        <div
          className="absolute inset-y-0 right-0 bg-black/60 pointer-events-none"
          style={{ left: Math.min(DISPLAY_W, displayCropX + displayCropW) }}
        />

        {/* Crop box — draggable */}
        <div
          className="absolute inset-y-0 border-2 border-indigo-400 cursor-ew-resize"
          style={{ left: Math.max(0, Math.min(maxDisplayX, displayCropX)), width: displayCropW }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* Drag handles */}
          <div className="absolute left-0 inset-y-0 w-1.5 bg-indigo-400/60" />
          <div className="absolute right-0 inset-y-0 w-1.5 bg-indigo-400/60" />
          {/* Center drag hint */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-indigo-500/30 rounded px-1.5 py-0.5">
              <span className="text-[10px] text-indigo-200 font-medium">drag</span>
            </div>
          </div>
        </div>

        {/* Modified badge */}
        {isModified && (
          <div className="absolute top-1.5 right-1.5 bg-amber-500 rounded px-1.5 py-0.5 pointer-events-none">
            <span className="text-[10px] text-black font-semibold">adjusted</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-0.5">
        <span className="text-xs text-zinc-400">{formatTime(frame.time)}</span>
        <span className={`text-[10px] font-medium ${DETECTION_COLORS[frame.detectionType] ?? 'text-zinc-500'}`}>
          {DETECTION_LABELS[frame.detectionType] ?? frame.detectionType}
        </span>
      </div>
    </div>
  )
}

export function ReviewStep({ jobId, frames, onRender }: ReviewStepProps) {
  const [cropPositions, setCropPositions] = useState<Record<number, number>>(
    Object.fromEntries(frames.map(f => [f.time, f.cropX]))
  )

  const adjustedCount = frames.filter(f => Math.abs(cropPositions[f.time] - f.cropX) > 2).length

  const handleRender = () => {
    const overrides = frames.map(f => ({ time: f.time, cropX: cropPositions[f.time] }))
    onRender(overrides)
  }

  const handleReset = () => {
    setCropPositions(Object.fromEntries(frames.map(f => [f.time, f.cropX])))
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-white">Review crop positions</p>
          {adjustedCount > 0 && (
            <button
              onClick={handleReset}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Reset all
            </button>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          Drag the blue box to reposition any frame. Your adjustments are saved as training data.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {frames.map(f => (
          <FrameCard
            key={f.time}
            frame={f}
            jobId={jobId}
            cropX={cropPositions[f.time]}
            onChange={x => setCropPositions(prev => ({ ...prev, [f.time]: x }))}
          />
        ))}
      </div>

      <div className="space-y-2">
        {adjustedCount > 0 && (
          <p className="text-xs text-amber-400 text-center">
            {adjustedCount} frame{adjustedCount > 1 ? 's' : ''} adjusted — correction{adjustedCount > 1 ? 's' : ''} will be saved
          </p>
        )}
        <button
          onClick={handleRender}
          className="w-full py-3.5 rounded-xl font-semibold text-sm bg-indigo-600 hover:bg-indigo-500 transition-colors"
        >
          Render Vertical Video
        </button>
      </div>
    </div>
  )
}
