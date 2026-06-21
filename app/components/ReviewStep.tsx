'use client'

import { useState, useRef, useCallback } from 'react'
import type { SampledFrame } from '@/lib/jobStore'

interface ReviewStepProps {
  jobId: string
  frames: SampledFrame[]
  onRender: (overrides: { time: number; cropX: number; cropX2?: number; splitScreen?: boolean }[]) => void
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
  cropX2,
  splitScreen,
  onChange,
  onChange2,
  onToggleSplit,
}: {
  frame: SampledFrame
  jobId: string
  cropX: number
  cropX2: number
  splitScreen: boolean
  onChange: (x: number) => void
  onChange2: (x: number) => void
  onToggleSplit: () => void
}) {
  const displayH = Math.round(DISPLAY_W * frame.frameH / frame.frameW)
  const scale = DISPLAY_W / frame.frameW
  const displayCropW = frame.cropW * scale
  const maxDisplayX = DISPLAY_W - displayCropW
  const halfDisplayH = Math.floor(displayH / 2)

  // Box 1 drag refs
  const isDragging1 = useRef(false)
  const drag1StartClientX = useRef(0)
  const drag1StartCropX = useRef(0)

  // Box 2 drag refs
  const isDragging2 = useRef(false)
  const drag2StartClientX = useRef(0)
  const drag2StartCropX = useRef(0)

  const onPointerDown1 = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    isDragging1.current = true
    drag1StartClientX.current = e.clientX
    drag1StartCropX.current = cropX
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [cropX])

  const onPointerMove1 = useCallback((e: React.PointerEvent) => {
    if (!isDragging1.current) return
    const dx = (e.clientX - drag1StartClientX.current) / scale
    onChange(Math.round(Math.max(0, Math.min(frame.frameW - frame.cropW, drag1StartCropX.current + dx))))
  }, [scale, frame.frameW, frame.cropW, onChange])

  const onPointerUp1 = useCallback(() => { isDragging1.current = false }, [])

  const onPointerDown2 = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    isDragging2.current = true
    drag2StartClientX.current = e.clientX
    drag2StartCropX.current = cropX2
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [cropX2])

  const onPointerMove2 = useCallback((e: React.PointerEvent) => {
    if (!isDragging2.current) return
    const dx = (e.clientX - drag2StartClientX.current) / scale
    onChange2(Math.round(Math.max(0, Math.min(frame.frameW - frame.cropW, drag2StartCropX.current + dx))))
  }, [scale, frame.frameW, frame.cropW, onChange2])

  const onPointerUp2 = useCallback(() => { isDragging2.current = false }, [])

  const displayCropX1 = Math.max(0, Math.min(maxDisplayX, cropX * scale))
  const displayCropX2 = Math.max(0, Math.min(maxDisplayX, cropX2 * scale))
  const isModified = !splitScreen && Math.abs(cropX - frame.cropX) > 2

  return (
    <div className="space-y-1.5">
      {/* Crop / Split Screen toggle */}
      <div className="flex rounded-md overflow-hidden border border-zinc-700 text-[10px] font-semibold">
        <button
          onClick={() => { if (splitScreen) onToggleSplit() }}
          className={`flex-1 py-1 transition-colors ${!splitScreen ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
        >
          Crop
        </button>
        <button
          onClick={() => { if (!splitScreen) onToggleSplit() }}
          className={`flex-1 py-1 transition-colors ${splitScreen ? 'bg-violet-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
        >
          Split Screen
        </button>
      </div>

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

        {splitScreen ? (
          <>
            {/* Dividing line */}
            <div
              className="absolute left-0 right-0 border-t-2 border-dashed border-violet-400 pointer-events-none z-10"
              style={{ top: halfDisplayH }}
            />

            {/* Top-half dim areas */}
            <div className="absolute left-0 bg-black/60 pointer-events-none" style={{ top: 0, width: displayCropX1, height: halfDisplayH }} />
            <div className="absolute right-0 bg-black/60 pointer-events-none" style={{ top: 0, left: displayCropX1 + displayCropW, height: halfDisplayH }} />

            {/* Top draggable box */}
            <div
              className="absolute border-2 border-indigo-400 cursor-ew-resize"
              style={{ top: 0, height: halfDisplayH, left: displayCropX1, width: displayCropW }}
              onPointerDown={onPointerDown1}
              onPointerMove={onPointerMove1}
              onPointerUp={onPointerUp1}
            >
              <div className="absolute left-0 inset-y-0 w-1.5 bg-indigo-400/60" />
              <div className="absolute right-0 inset-y-0 w-1.5 bg-indigo-400/60" />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="bg-indigo-500/40 rounded px-1 py-0.5 text-[9px] text-indigo-200 font-medium">top</span>
              </div>
            </div>

            {/* Bottom-half dim areas */}
            <div className="absolute left-0 bg-black/60 pointer-events-none" style={{ top: halfDisplayH, width: displayCropX2, bottom: 0 }} />
            <div className="absolute right-0 bg-black/60 pointer-events-none" style={{ top: halfDisplayH, left: displayCropX2 + displayCropW, bottom: 0 }} />

            {/* Bottom draggable box */}
            <div
              className="absolute border-2 border-violet-400 cursor-ew-resize"
              style={{ top: halfDisplayH, bottom: 0, left: displayCropX2, width: displayCropW }}
              onPointerDown={onPointerDown2}
              onPointerMove={onPointerMove2}
              onPointerUp={onPointerUp2}
            >
              <div className="absolute left-0 inset-y-0 w-1.5 bg-violet-400/60" />
              <div className="absolute right-0 inset-y-0 w-1.5 bg-violet-400/60" />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="bg-violet-500/40 rounded px-1 py-0.5 text-[9px] text-violet-200 font-medium">bottom</span>
              </div>
            </div>

            {/* Split badge */}
            <div className="absolute top-1.5 right-1.5 bg-violet-500 rounded px-1.5 py-0.5 pointer-events-none z-20">
              <span className="text-[10px] text-white font-semibold">split</span>
            </div>
          </>
        ) : (
          <>
            {/* Single-crop mode — full-height box */}
            <div className="absolute inset-y-0 left-0 bg-black/60 pointer-events-none" style={{ width: Math.max(0, displayCropX1) }} />
            <div className="absolute inset-y-0 right-0 bg-black/60 pointer-events-none" style={{ left: Math.min(DISPLAY_W, displayCropX1 + displayCropW) }} />
            <div
              className="absolute inset-y-0 border-2 border-indigo-400 cursor-ew-resize"
              style={{ left: displayCropX1, width: displayCropW }}
              onPointerDown={onPointerDown1}
              onPointerMove={onPointerMove1}
              onPointerUp={onPointerUp1}
            >
              <div className="absolute left-0 inset-y-0 w-1.5 bg-indigo-400/60" />
              <div className="absolute right-0 inset-y-0 w-1.5 bg-indigo-400/60" />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="bg-indigo-500/30 rounded px-1.5 py-0.5">
                  <span className="text-[10px] text-indigo-200 font-medium">drag</span>
                </div>
              </div>
            </div>

            {isModified && (
              <div className="absolute top-1.5 right-1.5 bg-amber-500 rounded px-1.5 py-0.5 pointer-events-none">
                <span className="text-[10px] text-black font-semibold">adjusted</span>
              </div>
            )}
          </>
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
  const [cropPositions2, setCropPositions2] = useState<Record<number, number>>(
    Object.fromEntries(frames.map(f => [f.time, f.cropX]))
  )
  const [splitModes, setSplitModes] = useState<Record<number, boolean>>({})

  const adjustedCount = frames.filter(f =>
    !splitModes[f.time] && Math.abs(cropPositions[f.time] - f.cropX) > 2
  ).length
  const splitCount = Object.values(splitModes).filter(Boolean).length

  const handleRender = () => {
    const overrides = frames.map(f => ({
      time: f.time,
      cropX: cropPositions[f.time],
      cropX2: cropPositions2[f.time],
      splitScreen: splitModes[f.time] ?? false,
    }))
    onRender(overrides)
  }

  const handleReset = () => {
    setCropPositions(Object.fromEntries(frames.map(f => [f.time, f.cropX])))
    setCropPositions2(Object.fromEntries(frames.map(f => [f.time, f.cropX])))
    setSplitModes({})
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-white">Review crop positions</p>
          {(adjustedCount > 0 || splitCount > 0) && (
            <button
              onClick={handleReset}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Reset all
            </button>
          )}
        </div>
        <p className="text-xs text-zinc-500">
          Drag the blue box to reposition. Toggle Split Screen to place two crop boxes — one per subject.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {frames.map(f => (
          <FrameCard
            key={f.time}
            frame={f}
            jobId={jobId}
            cropX={cropPositions[f.time]}
            cropX2={cropPositions2[f.time]}
            splitScreen={splitModes[f.time] ?? false}
            onChange={x => setCropPositions(prev => ({ ...prev, [f.time]: x }))}
            onChange2={x => setCropPositions2(prev => ({ ...prev, [f.time]: x }))}
            onToggleSplit={() => setSplitModes(prev => ({ ...prev, [f.time]: !prev[f.time] }))}
          />
        ))}
      </div>

      <div className="space-y-2">
        {(adjustedCount > 0 || splitCount > 0) && (
          <p className="text-xs text-amber-400 text-center">
            {[
              adjustedCount > 0 && `${adjustedCount} crop${adjustedCount > 1 ? 's' : ''} adjusted`,
              splitCount > 0 && `${splitCount} frame${splitCount > 1 ? 's' : ''} set to split screen`,
            ].filter(Boolean).join(' · ')}
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
