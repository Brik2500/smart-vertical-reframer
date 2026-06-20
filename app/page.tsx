'use client'

import { useState, useRef, useCallback } from 'react'

type Mode = 'auto' | 'smart-crop' | 'split-screen'
type Stage = 'idle' | 'uploading' | 'processing' | 'done' | 'error'

const MODE_INFO = {
  auto: {
    label: 'Auto',
    description: 'Detects faces and picks the best mode automatically.',
  },
  'smart-crop': {
    label: 'Smart Crop',
    description: 'Tracks and centers the primary subject.',
  },
  'split-screen': {
    label: 'Split Screen',
    description: 'Preserves two people in a stacked layout.',
  },
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('auto')
  const [stage, setStage] = useState<Stage>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reset = () => {
    setStage('idle')
    setFile(null)
    setJobId(null)
    setError(null)
    if (pollRef.current) clearInterval(pollRef.current)
  }

  const handleFile = (f: File) => {
    if (!f.type.startsWith('video/')) {
      setError('Please upload a video file.')
      return
    }
    setFile(f)
    setError(null)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [])

  const pollStatus = (id: string) => {
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/status/${id}`)
      const data = await res.json()

      if (data.status === 'done') {
        clearInterval(pollRef.current!)
        setStage('done')
      } else if (data.status === 'error') {
        clearInterval(pollRef.current!)
        setError(data.error || 'Processing failed.')
        setStage('error')
      }
    }, 2000)
  }

  const handleGenerate = async () => {
    if (!file) return
    setError(null)
    setStage('uploading')

    try {
      const formData = new FormData()
      formData.append('video', file)
      formData.append('mode', mode)

      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData })
      if (!uploadRes.ok) throw new Error('Upload failed')
      const { jobId: id } = await uploadRes.json()
      setJobId(id)

      const processRes = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id }),
      })
      if (!processRes.ok) throw new Error('Failed to start processing')

      setStage('processing')
      pollStatus(id)
    } catch (err) {
      setError(String(err))
      setStage('error')
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-xl space-y-8">

        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Smart Vertical Reframer</h1>
          <p className="text-zinc-400 text-sm">
            Convert horizontal footage to vertical without losing the people who matter.
          </p>
        </div>

        {/* Upload area */}
        <div
          className={`relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
            dragOver
              ? 'border-indigo-500 bg-indigo-500/10'
              : file
              ? 'border-zinc-600 bg-zinc-900'
              : 'border-zinc-700 hover:border-zinc-500 bg-zinc-900'
          }`}
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
          {file ? (
            <div className="space-y-1">
              <p className="text-white font-medium truncate">{file.name}</p>
              <p className="text-zinc-500 text-xs">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
              <button
                className="mt-2 text-xs text-zinc-500 hover:text-zinc-300 underline"
                onClick={e => { e.stopPropagation(); reset() }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-zinc-300 font-medium">Drop a 16:9 video here</p>
              <p className="text-zinc-500 text-xs">or click to browse</p>
            </div>
          )}
        </div>

        {/* Mode selector */}
        <div className="space-y-2">
          <p className="text-xs text-zinc-500 uppercase tracking-widest font-medium">Reframing mode</p>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(MODE_INFO) as Mode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-lg px-3 py-3 text-left transition-colors border ${
                  mode === m
                    ? 'border-indigo-500 bg-indigo-500/10 text-white'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-600'
                }`}
              >
                <p className="font-medium text-sm">{MODE_INFO[m].label}</p>
                <p className="text-xs mt-0.5 leading-snug opacity-70">{MODE_INFO[m].description}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Action / Status */}
        {stage === 'idle' || stage === 'error' ? (
          <button
            onClick={handleGenerate}
            disabled={!file}
            className="w-full py-3.5 rounded-xl font-semibold text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Generate Vertical
          </button>
        ) : stage === 'uploading' ? (
          <StatusCard label="Uploading…" sub="Sending video to server" />
        ) : stage === 'processing' ? (
          <StatusCard label="Processing…" sub="Detecting faces and reframing. This may take a minute." spinner />
        ) : stage === 'done' ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-400 text-center font-medium">
              Done! Your vertical video is ready.
            </div>
            <a
              href={`/api/download/${jobId}`}
              download
              className="block w-full py-3.5 rounded-xl font-semibold text-sm bg-emerald-600 hover:bg-emerald-500 transition-colors text-center"
            >
              Download Video
            </a>
            <button
              onClick={reset}
              className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Reframe another video
            </button>
          </div>
        ) : null}
      </div>
    </main>
  )
}

function StatusCard({ label, sub, spinner }: { label: string; sub: string; spinner?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4 flex items-center gap-4">
      {spinner && (
        <div className="w-5 h-5 border-2 border-zinc-600 border-t-indigo-500 rounded-full animate-spin shrink-0" />
      )}
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>
      </div>
    </div>
  )
}
