'use client'

import { useState, useRef, useCallback } from 'react'
import { ReviewStep } from './components/ReviewStep'
import type { SampledFrame } from '@/lib/jobStore'

type Stage = 'idle' | 'uploading' | 'detecting' | 'reviewing' | 'rendering' | 'done' | 'error'

const PROJECT_TYPES = ['Podcast', 'Interview', 'Documentary', 'Narrative', 'Other'] as const
type ProjectType = typeof PROJECT_TYPES[number]

const ALLOWED_MIME = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm']
const MAX_SIZE_MB = 200
const MAX_DURATION_S = 5 * 60

const PROBLEM_TAGS = [
  'Lost face',
  'Wrong speaker',
  "Didn't split two-shot",
  'Jumpy framing',
  'Cropped object',
  'Other',
]

// Returns the video duration in seconds, or null if the browser can't read it
// within 5 seconds (e.g. some iPhone .mov HEVC files stall on loadedmetadata).
// Null means "unknown — defer to server-side size check only."
function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    let settled = false

    const settle = (result: number | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      resolve(result)
    }

    const timeout = setTimeout(() => settle(null), 5000)

    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      clearTimeout(timeout)
      const d = video.duration
      settle(isFinite(d) && !isNaN(d) ? d : null)
    }
    video.onerror = () => { clearTimeout(timeout); settle(null) }
    video.src = url
  })
}

function formatDuration(s: number) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function Home() {
  const [stage, setStage] = useState<Stage>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [projectType, setProjectType] = useState<ProjectType | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [sampledFrames, setSampledFrames] = useState<SampledFrame[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [validating, setValidating] = useState(false)

  // Survey state
  const [surveyDone, setSurveyDone] = useState(false)
  const [rating, setRating] = useState<number | null>(null)
  const [tags, setTags] = useState<string[]>([])
  const [wouldUseAgain, setWouldUseAgain] = useState<boolean | null>(null)
  const [freeText, setFreeText] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reset = () => {
    setStage('idle')
    setFile(null)
    setProjectType(null)
    setJobId(null)
    setSampledFrames([])
    setError(null)
    setSurveyDone(false)
    setRating(null)
    setTags([])
    setWouldUseAgain(null)
    setFreeText('')
    if (pollRef.current) clearInterval(pollRef.current)
  }

  const handleFile = useCallback(async (f: File) => {
    setError(null)

    // Format check
    if (!f.type.startsWith('video/')) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? '?'
      setError(`We support MP4, MOV, and AVI. This file appears to be .${ext}.`)
      return
    }
    if (!ALLOWED_MIME.includes(f.type)) {
      const ext = f.name.split('.').pop()?.toLowerCase() ?? f.type.split('/')[1] ?? '?'
      setError(`We support MP4, MOV, and AVI. This file appears to be .${ext}.`)
      return
    }

    // Size check
    const sizeMB = f.size / 1024 / 1024
    if (sizeMB > MAX_SIZE_MB) {
      setError(`This file is ${sizeMB.toFixed(0)}MB — trial limit is ${MAX_SIZE_MB}MB. Try a lower bitrate export.`)
      return
    }

    // Duration check (async) — null means browser couldn't read it; defer to server size check
    setValidating(true)
    const dur = await probeVideoDuration(f)
    setValidating(false)
    if (dur !== null && dur > MAX_DURATION_S) {
      setError(`This video is ${formatDuration(dur)} — trial limit is 5 minutes. Trim it and try again.`)
      return
    }
    setFile(f)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFile(f)
  }, [handleFile])

  const pollStatus = (id: string) => {
    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/status/${id}`)
      const data = await res.json()

      if (data.status === 'review') {
        clearInterval(pollRef.current!)
        setSampledFrames(data.sampledFrames ?? [])
        setStage('reviewing')
      } else if (data.status === 'done') {
        clearInterval(pollRef.current!)
        setStage('done')
      } else if (data.status === 'error') {
        clearInterval(pollRef.current!)
        setError(data.error || 'Processing failed.')
        setStage('error')
      }
    }, 2000)
  }

  const handleUpload = async () => {
    if (!file) return
    setError(null)
    setStage('uploading')

    try {
      const formData = new FormData()
      formData.append('video', file)
      formData.append('mode', 'auto')
      if (projectType) formData.append('projectType', projectType)

      const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData })
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}))
        throw new Error(body.error || 'Upload failed')
      }
      const { jobId: id } = await uploadRes.json()
      setJobId(id)

      const detectRes = await fetch('/api/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: id }),
      })
      if (!detectRes.ok) throw new Error('Failed to start detection')

      setStage('detecting')
      pollStatus(id)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
      setStage('error')
    }
  }

  const handleRender = async (overrides: { time: number; cropX: number; cropX2?: number; splitScreen?: boolean }[]) => {
    if (!jobId) return
    setStage('rendering')

    try {
      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, overrides }),
      })
      if (!res.ok) throw new Error('Failed to start render')
      pollStatus(jobId)
    } catch (err) {
      setError(String(err).replace(/^Error:\s*/, ''))
      setStage('error')
    }
  }

  const handleSurveySubmit = async () => {
    if (!jobId) return
    setSurveyDone(true)
    fetch('/api/survey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, rating, tags, wouldUseAgain, freeText }),
    }).catch(() => {/* fire-and-forget */})
  }

  const toggleTag = (tag: string) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag])
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

        {/* Upload UI — only show when idle/error */}
        {(stage === 'idle' || stage === 'error') && (
          <>
            {/* Drop zone */}
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
                accept="video/mp4,video/quicktime,video/x-msvideo,video/webm"
                className="hidden"
                onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              {validating ? (
                <div className="flex items-center justify-center gap-2 text-zinc-400 text-sm">
                  <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-500 rounded-full animate-spin" />
                  Checking file…
                </div>
              ) : file ? (
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
                  <p className="text-zinc-500 text-xs">MP4, MOV, or AVI · max 5 min · 200MB</p>
                </div>
              )}
            </div>

            {/* Project type */}
            {file && (
              <div className="space-y-2">
                <p className="text-xs text-zinc-500 uppercase tracking-widest font-medium">Project type</p>
                <div className="flex flex-wrap gap-2">
                  {PROJECT_TYPES.map(pt => (
                    <button
                      key={pt}
                      onClick={() => setProjectType(pt === projectType ? null : pt)}
                      className={`rounded-full px-3.5 py-1.5 text-sm font-medium border transition-colors ${
                        projectType === pt
                          ? 'border-indigo-500 bg-indigo-500/15 text-white'
                          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500'
                      }`}
                    >
                      {pt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={!file || validating}
              className="w-full py-3.5 rounded-xl font-semibold text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Convert to Vertical
            </button>
          </>
        )}

        {/* Status cards */}
        {stage === 'uploading' && (
          <StatusCard label="Uploading…" sub="Sending video to server" />
        )}
        {stage === 'detecting' && (
          <StatusCard label="Analyzing…" sub="Detecting faces, objects, and text across sampled frames." spinner />
        )}
        {stage === 'rendering' && (
          <StatusCard label="Rendering…" sub="Applying crop positions and encoding. This may take a minute." spinner />
        )}

        {/* Review step */}
        {stage === 'reviewing' && jobId && sampledFrames.length > 0 && (
          <ReviewStep
            jobId={jobId}
            frames={sampledFrames}
            onRender={handleRender}
          />
        )}

        {/* Done */}
        {stage === 'done' && (
          <div className="space-y-4">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-400 text-center font-medium">
              Done! Your vertical video is ready.
            </div>

            {/* Survey */}
            {!surveyDone ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4 space-y-4">
                <p className="text-sm font-medium text-white">Quick feedback <span className="text-zinc-500 font-normal">(optional)</span></p>

                {/* Star rating */}
                <div className="space-y-1.5">
                  <p className="text-xs text-zinc-500">Overall watchability</p>
                  <div className="flex gap-1.5">
                    {[1, 2, 3, 4, 5].map(n => (
                      <button
                        key={n}
                        onClick={() => setRating(n === rating ? null : n)}
                        className={`text-xl transition-colors ${n <= (rating ?? 0) ? 'text-yellow-400' : 'text-zinc-700 hover:text-zinc-500'}`}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                </div>

                {/* Problem tags — only if low rating */}
                {rating !== null && rating <= 3 && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-zinc-500">What went wrong?</p>
                    <div className="flex flex-wrap gap-2">
                      {PROBLEM_TAGS.map(tag => (
                        <button
                          key={tag}
                          onClick={() => toggleTag(tag)}
                          className={`rounded-full px-3 py-1 text-xs border transition-colors ${
                            tags.includes(tag)
                              ? 'border-red-500/60 bg-red-500/10 text-red-300'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                          }`}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Would use again */}
                <div className="space-y-1.5">
                  <p className="text-xs text-zinc-500">Would you use this again?</p>
                  <div className="flex gap-2">
                    {(['Yes', 'No'] as const).map(v => (
                      <button
                        key={v}
                        onClick={() => setWouldUseAgain(wouldUseAgain === (v === 'Yes') ? null : v === 'Yes')}
                        className={`rounded-lg px-4 py-1.5 text-sm border transition-colors ${
                          wouldUseAgain === (v === 'Yes')
                            ? 'border-indigo-500 bg-indigo-500/15 text-white'
                            : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500'
                        }`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Free text */}
                <input
                  type="text"
                  placeholder="Anything else? (optional)"
                  value={freeText}
                  onChange={e => setFreeText(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                />

                <div className="flex gap-2">
                  <button
                    onClick={handleSurveySubmit}
                    disabled={rating === null && wouldUseAgain === null && !freeText.trim()}
                    className="flex-1 py-2 rounded-lg text-sm font-medium bg-zinc-700 hover:bg-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    Submit feedback
                  </button>
                  <button
                    onClick={() => setSurveyDone(true)}
                    className="px-4 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    Skip
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-zinc-600 text-center">Thanks for the feedback.</p>
            )}

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
        )}
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
