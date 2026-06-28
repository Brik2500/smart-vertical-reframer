'use client'

import { useState, useRef } from 'react'
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

function formatSeconds(s: number): string {
  return `${s.toFixed(1)}s`
}

// Minimap bar: shows where the crop window sits within the full frame width.
// The highlighted segment tracks the current cropX live as you drag.
function CropPositionBar({ cropX, frameW, cropW }: { cropX: number; frameW: number; cropW: number }) {
  const maxX = frameW - cropW
  const leftPct = maxX > 0 ? (cropX / maxX) * (1 - cropW / frameW) * 100 : 0
  const widthPct = (cropW / frameW) * 100
  return (
    <div className="relative h-1 bg-zinc-700 rounded-full overflow-hidden">
      <div
        className="absolute h-full bg-indigo-400 rounded-full transition-none"
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      />
    </div>
  )
}

const DISPLAY_W = 260

// A single draggable crop box overlay on one copy of the frame thumbnail.
function CropOverlay({
  jobId,
  frame,
  displayH,
  cropX,
  displayCropW,
  borderColor,
  handleColor,
  label,
  labelColor,
  onChange,
}: {
  jobId: string
  frame: SampledFrame
  displayH: number
  cropX: number
  displayCropW: number
  borderColor: string
  handleColor: string
  label: string
  labelColor: string
  onChange: (x: number) => void
}) {
  const scale = DISPLAY_W / frame.frameW
  const maxSourceX = frame.frameW - Math.round(displayCropW / scale)
  const displayX = Math.max(0, Math.min(DISPLAY_W - displayCropW, cropX * scale))

  const isDragging = useRef(false)
  const startClientX = useRef(0)
  const startCropX = useRef(0)

  return (
    <div
      className="relative overflow-hidden rounded-lg bg-zinc-900 select-none touch-none"
      style={{ width: DISPLAY_W, height: displayH }}
    >
      <img
        src={`/api/frames/${jobId}/${frame.filename}`}
        alt=""
        width={DISPLAY_W}
        height={displayH}
        className="absolute inset-0 object-cover pointer-events-none"
        draggable={false}
      />

      {/* Dim left */}
      <div className="absolute inset-y-0 left-0 bg-black/60 pointer-events-none" style={{ width: displayX }} />
      {/* Dim right */}
      <div className="absolute inset-y-0 right-0 bg-black/60 pointer-events-none" style={{ left: displayX + displayCropW }} />

      {/* Draggable box */}
      <div
        className={`absolute inset-y-0 border-2 cursor-ew-resize ${borderColor}`}
        style={{ left: displayX, width: displayCropW }}
        onPointerDown={e => {
          e.preventDefault()
          isDragging.current = true
          startClientX.current = e.clientX
          startCropX.current = cropX
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          if (!isDragging.current) return
          const dx = (e.clientX - startClientX.current) / scale
          onChange(Math.round(Math.max(0, Math.min(maxSourceX, startCropX.current + dx))))
        }}
        onPointerUp={() => { isDragging.current = false }}
      >
        <div className={`absolute left-0 inset-y-0 w-1.5 ${handleColor}`} />
        <div className={`absolute right-0 inset-y-0 w-1.5 ${handleColor}`} />
      </div>

      {/* Output position label */}
      <div className={`absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[9px] font-semibold pointer-events-none ${labelColor}`}>
        {label}
      </div>
    </div>
  )
}

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

  // Smart-crop: 9:16 strip
  const displayCropW = frame.cropW * scale
  // Split-screen: 9:8 full-height strip (each half output is 9:8)
  const splitStripW = Math.floor(frame.frameH * 9 / 8)
  const displaySplitW = Math.min(DISPLAY_W, splitStripW * scale)

  const isModified = !splitScreen && Math.abs(cropX - frame.cropX) > 2

  // Shared drag state for single-crop mode
  const isDragging = useRef(false)
  const startClientX = useRef(0)
  const startCropX = useRef(0)
  const displayX = Math.max(0, Math.min(DISPLAY_W - displayCropW, cropX * scale))

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

      {splitScreen ? (
        // Two separate frame copies — one per subject, no overlap
        <div className="space-y-1">
          <CropOverlay
            jobId={jobId}
            frame={frame}
            displayH={displayH}
            cropX={cropX}
            displayCropW={displaySplitW}
            borderColor="border-indigo-400"
            handleColor="bg-indigo-400/60"
            label="▲ top output"
            labelColor="bg-indigo-900/80 text-indigo-200"
            onChange={onChange}
          />
          <div className="flex items-center gap-1.5 px-0.5">
            <div className="flex-1 border-t border-dashed border-zinc-600" />
            <span className="text-[9px] text-zinc-500 font-medium">split</span>
            <div className="flex-1 border-t border-dashed border-zinc-600" />
          </div>
          <CropOverlay
            jobId={jobId}
            frame={frame}
            displayH={displayH}
            cropX={cropX2}
            displayCropW={displaySplitW}
            borderColor="border-violet-400"
            handleColor="bg-violet-400/60"
            label="▼ bottom output"
            labelColor="bg-violet-900/80 text-violet-200"
            onChange={onChange2}
          />
        </div>
      ) : (
        // Single-crop mode
        <div
          className="relative overflow-hidden rounded-lg bg-zinc-900 select-none touch-none"
          style={{ width: DISPLAY_W, height: displayH }}
        >
          <img
            src={`/api/frames/${jobId}/${frame.filename}`}
            alt={`Frame at ${formatTime(frame.time)}`}
            width={DISPLAY_W}
            height={displayH}
            className="absolute inset-0 object-cover pointer-events-none"
            draggable={false}
          />
          <div className="absolute inset-y-0 left-0 bg-black/60 pointer-events-none" style={{ width: Math.max(0, displayX) }} />
          <div className="absolute inset-y-0 right-0 bg-black/60 pointer-events-none" style={{ left: Math.min(DISPLAY_W, displayX + displayCropW) }} />
          <div
            className="absolute inset-y-0 border-2 border-indigo-400 cursor-ew-resize"
            style={{ left: displayX, width: displayCropW }}
            onPointerDown={e => {
              e.preventDefault()
              isDragging.current = true
              startClientX.current = e.clientX
              startCropX.current = cropX
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            }}
            onPointerMove={e => {
              if (!isDragging.current) return
              const dx = (e.clientX - startClientX.current) / scale
              onChange(Math.round(Math.max(0, Math.min(frame.frameW - frame.cropW, startCropX.current + dx))))
            }}
            onPointerUp={() => { isDragging.current = false }}
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
        </div>
      )}

      {/* Position minimap — only in single-crop mode */}
      {!splitScreen && (
        <CropPositionBar cropX={cropX} frameW={frame.frameW} cropW={frame.cropW} />
      )}

      {/* Timestamp + detection label */}
      <div className="flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400">{formatTime(frame.time)}</span>
          <span className="text-[10px] text-zinc-600">{formatSeconds(frame.time)}</span>
        </div>
        <span className={`text-[10px] font-medium ${DETECTION_COLORS[frame.detectionType] ?? 'text-zinc-500'}`}>
          {DETECTION_LABELS[frame.detectionType] ?? frame.detectionType}
        </span>
      </div>

      {/* Dialogue — shown when Whisper transcript is available */}
      {frame.dialogue && (
        <p className="px-0.5 text-[10px] text-zinc-400 leading-relaxed italic line-clamp-2">
          "{frame.dialogue}"
        </p>
      )}
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
          Drag the blue box to reposition. Toggle Split Screen to set crop positions for each output half independently.
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
