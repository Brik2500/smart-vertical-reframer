// smartCropStabilizer.ts
//
// Fixes the root cause identified from frame analysis:
// sparse face-detection keyframes (~1 every 6s) were sparser than the
// fixed 5s "cut" threshold, so almost every transition got misclassified
// as a deliberate cut and snapped instantly -- including transitions
// driven by a single bad/low-confidence face detection. This module:
//   1. Detects real scene cuts independently (histogram correlation),
//      decoupled from how far apart your keyframes happen to be.
//   2. Rejects outlier keyframes (sharp x-jumps with no corroborating
//      scene cut) before they reach the interpolator.
//   3. Classifies cut vs. pan using the independent scene-cut signal,
//      not dt/dv heuristics.
//   4. Falls back to holding the last known-good position instead of
//      drifting toward a low-confidence reading when there's nothing
//      trustworthy to interpolate toward.

export interface Keyframe {
  t: number;            // timestamp in seconds
  x: number;            // detected crop-center x position
  confidence?: number;  // detector confidence, 0-1. Assume 1.0 if absent.
}

export interface ClassifiedSegment {
  fromT: number;
  toT: number;
  fromX: number;
  toX: number;
  type: 'cut' | 'pan';
  cutAt?: number;  // for 'cut' segments: the exact scene-cut timestamp within (fromT, toT]
}

// ---------- 1. Scene-cut detection ----------
//
// Cheap, frame-level histogram correlation. Pass in two grayscale
// histograms (e.g. computed once per sampled frame in your existing
// frame-sampling pass -- no need to re-decode frames here).
//
// Swap in SSIM or a perceptual hash if you want something more robust;
// histogram correlation is intentionally cheap since it just needs to
// answer "did the visual content change a lot," not give a precise score.

export function isSceneCut(
  histA: Float64Array | number[],
  histB: Float64Array | number[],
  threshold = 0.45
): boolean {
  const correlation = histogramCorrelation(histA, histB);
  return correlation < threshold;
}

function histogramCorrelation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let meanA = 0, meanB = 0;
  for (let i = 0; i < n; i++) { meanA += a[i]; meanB += b[i]; }
  meanA /= n; meanB /= n;

  let num = 0, denomA = 0, denomB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  return denom === 0 ? 1 : num / denom;
}

// ---------- 2. Outlier rejection ----------
//
// A keyframe is only trusted as a real jump if a scene cut at (or very
// near) its timestamp corroborates it. Otherwise a sharp x deviation
// from its neighbors' expected interpolated position is treated as a
// misdetection and dropped.

export interface OutlierRejectionOptions {
  cropWidth: number;
  maxJumpFraction?: number;   // default 0.25 (25% of crop width)
  minConfidence?: number;     // default 0.5
  sceneCutAt: (t: number) => boolean; // proximity check, kept for legacy callers
  sceneCuts?: number[];       // raw cut timestamps for range-based outlier check
}

export function filterOutlierKeyframes(
  keyframes: Keyframe[],
  opts: OutlierRejectionOptions
): Keyframe[] {
  const { cropWidth, maxJumpFraction = 0.25, minConfidence = 0.5, sceneCutAt, sceneCuts = [] } = opts;

  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  const cleaned: Keyframe[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const kf = sorted[i];

    // Drop low-confidence detections outright -- don't let a single
    // shaky reading become a trusted keyframe.
    if ((kf.confidence ?? 1.0) < minConfidence) {
      continue;
    }

    const prev = cleaned[cleaned.length - 1];
    const next = sorted[i + 1];

    if (prev && next) {
      const span = next.t - prev.t;
      const expectedX = span > 1e-6
        ? prev.x + (next.x - prev.x) * ((kf.t - prev.t) / span)
        : prev.x;

      const deviation = Math.abs(kf.x - expectedX) / cropWidth;

      // A position jump is justified if a scene cut falls anywhere between
      // the previous kept keyframe and this one (range check, not proximity).
      // The old sceneCutAt(kf.t) point-check used a ±0.5s epsilon that missed
      // post-cut bracket samples landing 0.6–0.75s after the cut.
      const cutJustifiesJump = prev
        ? sceneCuts.some(c => c > prev.t && c <= kf.t)
        : false;

      if (deviation > maxJumpFraction && !cutJustifiesJump) {
        // Only drop if the keyframe deviates significantly from BOTH raw neighbors.
        // Deviation from just prev = start of a new sustained position (real move).
        // Deviation from just next = end of a sustained position (real move).
        // An isolated spike deviates from both — that's the only case to reject.
        const deviationFromPrev = Math.abs(kf.x - prev.x) / cropWidth;
        const deviationFromNext = Math.abs(kf.x - next.x) / cropWidth;
        if (deviationFromPrev > maxJumpFraction && deviationFromNext > maxJumpFraction) {
          continue; // isolated spike — drop it
        }
      }
    }

    cleaned.push(kf);
  }

  return cleaned;
}

// ---------- 3. Cut vs. pan classification ----------
//
// Replaces the old `dv > 30% OR dt > 5s` heuristic. A transition is a
// cut only if the independent scene-cut signal says so -- never inferred
// from keyframe spacing alone.

// sceneCuts must be the raw detected cut timestamps (seconds).
// A segment is a 'cut' if any cut timestamp falls strictly inside
// (fromT, toT] — range check, not proximity to a single boundary.
// The old sceneCutAt(b.t) point-check was off-by-one: it matched cuts
// near the segment END, missing cuts in the middle and false-flagging
// cuts just beyond the end.
export function classifySegments(
  keyframes: Keyframe[],
  sceneCuts: number[]
): ClassifiedSegment[] {
  const sorted = [...sceneCuts].sort((a, b) => a - b);
  const segments: ClassifiedSegment[] = [];

  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];

    const cutAt = sorted.find(c => c > a.t && c <= b.t);

    segments.push({
      fromT: a.t,
      toT: b.t,
      fromX: a.x,
      toX: b.x,
      type: cutAt !== undefined ? 'cut' : 'pan',
      cutAt,
    });
  }

  return segments;
}

// ---------- 4. Position resolution with hold-last-good fallback ----------

export function resolveCropX(
  t: number,
  segments: ClassifiedSegment[],
  frameCenterX: number
): number {
  if (segments.length === 0) return frameCenterX;

  const first = segments[0];
  if (t <= first.fromT) {
    const span = first.fromT;
    const progress = span > 1e-6 ? Math.min(t / span, 1) : 1;
    return lerp(frameCenterX, first.fromX, smoothstep(progress));
  }

  for (const seg of segments) {
    if (t >= seg.fromT && t <= seg.toT) {
      if (seg.type === 'cut') {
        return t >= seg.toT ? seg.toX : seg.fromX;
      }
      const span = seg.toT - seg.fromT;
      const progress = span > 1e-6 ? (t - seg.fromT) / span : 1;
      return lerp(seg.fromX, seg.toX, smoothstep(progress));
    }
  }

  return segments[segments.length - 1].toX;
}

function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 3 * clamped * clamped - 2 * clamped * clamped * clamped;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------- End-to-end pipeline ----------

export interface BuildStabilizedKeyframesOptions {
  rawKeyframes: Keyframe[];
  cropWidth: number;
  sceneCutAt: (t: number) => boolean;  // point-check for outlier rejection
  sceneCuts?: number[];                 // raw timestamps for range-based classification
  maxJumpFraction?: number;
  minConfidence?: number;
}

export function buildStabilizedSegments(
  options: BuildStabilizedKeyframesOptions
): ClassifiedSegment[] {
  const {
    rawKeyframes,
    cropWidth,
    sceneCutAt,
    sceneCuts = [],
    maxJumpFraction = 0.25,
    minConfidence = 0.5,
  } = options;

  const cleaned = filterOutlierKeyframes(rawKeyframes, {
    cropWidth,
    maxJumpFraction,
    minConfidence,
    sceneCutAt,
    sceneCuts,
  });

  return classifySegments(cleaned, sceneCuts);
}

// ---------- FFmpeg expression builder ----------
//
// Consumes ClassifiedSegment[] and emits a baked FFmpeg crop-filter
// expression compatible with buildDynamicSmartCropFilter's output format.
// Cut segments snap instantly; pan segments smoothstep-ease.

// Maximum seconds past the last keyframe (or before the first) to hold a stale
// position before easing back toward frame center. Tune downward for fast-moving
// content where 0.8s of stale hold is still too long.
const STALE_HOLD_THRESHOLD = 0.8

export function buildFFmpegExprFromSegments(
  segments: ClassifiedSegment[],
  maxX: number,
  frameCenterX: number,
  segmentDuration?: number,
  nextSegmentFirstX?: number,
  prevSegmentLastX?: number,
  segmentEndsAtCut?: boolean,
  segmentStartsAtCut?: boolean
): string {
  if (segments.length === 0) return String(frameCenterX);

  const last = segments[segments.length - 1];

  // Tail: hold at last keyframe position for STALE_HOLD_THRESHOLD seconds.
  // If the tail boundary is a scene cut, skip easing entirely — the neighbor's
  // position belongs to a different shot and easing toward it would pan wrong
  // content. If not a cut (sparse detection mid-shot), ease toward the next
  // segment's first detected position (or frame center if no neighbor exists).
  // Falls through to constant hold when segmentDuration is not provided (backward compat).
  let expr: string;
  if (segmentDuration !== undefined) {
    const holdEnd = last.toT + STALE_HOLD_THRESHOLD;
    if (holdEnd < segmentDuration) {
      const easeOver = segmentDuration - holdEnd;
      if (segmentEndsAtCut) {
        // Tail is at a scene cut — neighbor position is from a different shot.
        // Collapse to simple hold with no ease.
        console.log(
          `[crop] stale hold at ${last.toT.toFixed(2)}s (seg ends ${segmentDuration.toFixed(2)}s): ` +
          `tail at cut boundary — holding (no ease)`
        )
        expr = String(last.toX)
      } else {
        const tailTarget = nextSegmentFirstX ?? frameCenterX;
        const tailDesc = nextSegmentFirstX !== undefined ? `next-seg x=${nextSegmentFirstX}` : 'center';
        const norm = `((t-${holdEnd.toFixed(4)})/${easeOver.toFixed(4)})`;
        const smooth = `(${norm}*${norm}*(3.0-2.0*${norm}))`;
        const eased = `(${last.toX}+(${tailTarget - last.toX})*${smooth})`;
        console.log(
          `[crop] stale hold at ${last.toT.toFixed(2)}s (seg ends ${segmentDuration.toFixed(2)}s): ` +
          `holding ${STALE_HOLD_THRESHOLD}s then easing to ${tailDesc} over ${easeOver.toFixed(2)}s`
        )
        expr = `if(lt(t,${holdEnd.toFixed(4)}),${last.toX},max(0,min(${maxX},${eased})))`
      }
    } else {
      expr = String(last.toX)
    }
  } else {
    expr = String(last.toX)
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    let segExpr: string;

    if (seg.type === 'cut') {
      // Hold outgoing position until the visual cut, then snap to incoming.
      // cutAt is the actual scene-cut timestamp — snap there, not at toT,
      // so we don't spend 0.75s in the new shot with the wrong crop position.
      const snapAt = seg.cutAt ?? seg.fromT;
      segExpr = `if(lt(t,${snapAt}),${seg.fromX},${seg.toX})`;
    } else {
      const dt = seg.toT - seg.fromT;
      const norm = `((t-${seg.fromT})/${dt.toFixed(4)})`;
      const smooth = `(${norm}*${norm}*(3.0-2.0*${norm}))`;
      const eased = `(${seg.fromX}+(${seg.toX - seg.fromX})*${smooth})`;
      segExpr = `max(0,min(${maxX},${eased}))`;
    }

    expr = `if(between(t,${seg.fromT},${seg.toT}),${segExpr},${expr})`;
  }

  // Pre-roll: symmetric stale-hold logic.
  // Within STALE_HOLD_THRESHOLD of the first keyframe: smoothstep from center to
  // first.fromX so the subject entry is smooth. Beyond the threshold: hold at center,
  // since we have no data and center is statistically safer than a stale position.
  // For the common case (post-cut bracket lands ~0.75s in), first.fromT ≤ threshold
  // so we just hold at first.fromX from t=0 — the new branch only fires when early
  // low-confidence samples get filtered out and the first keyframe is further in.
  const first = segments[0];
  if (first.fromT > 0) {
    if (first.fromT > STALE_HOLD_THRESHOLD) {
      const easeStart = first.fromT - STALE_HOLD_THRESHOLD;
      const noEase = segmentStartsAtCut || prevSegmentLastX === undefined;
      if (noEase) {
        const reason = segmentStartsAtCut ? 'cut boundary' : 'no prior segment';
        console.log(`[crop] long pre-roll: ${reason} — holding at x=${first.fromX} (no ease)`)
        expr = `if(lt(t,${first.fromT}),${first.fromX},${expr})`;
      } else {
        const preTarget = prevSegmentLastX;
        const preDesc = `prev-seg x=${prevSegmentLastX}`;
        const norm = `((t-${easeStart.toFixed(4)})/${STALE_HOLD_THRESHOLD.toFixed(4)})`;
        const smooth = `(${norm}*${norm}*(3.0-2.0*${norm}))`;
        const eased = `max(0,min(${maxX},(${preTarget}+(${first.fromX - preTarget})*${smooth})))`;
        expr = `if(lt(t,${easeStart.toFixed(4)}),${preTarget},if(lt(t,${first.fromT}),${eased},${expr}))`;
        console.log(`[crop] long pre-roll: holding at ${preDesc} then easing to x=${first.fromX} over ${STALE_HOLD_THRESHOLD.toFixed(1)}s`)
      }
    } else {
      // Short pre-roll — hold at first detected position from t=0.
      expr = `if(lt(t,${first.fromT}),${first.fromX},${expr})`;
    }
  }

  return expr;
}
