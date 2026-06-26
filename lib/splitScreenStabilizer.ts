// splitScreenStabilizer.ts
//
// Within split-screen segments, per-sample face detections sometimes only
// find ONE of the two speakers (head turn, occlusion, motion blur). When
// that happens the naive approach assigns the single detection to BOTH
// panes — producing a visible duplicate-face glitch. This module:
//   1. Matches a single detection to whichever pane it's closest to by
//      previous position, and holds the other pane at its last known x.
//   2. Matches two detections to panes using minimum-cost assignment so
//      panes don't swap identities when faces momentarily cross.
//   3. Holds both panes on zero detections.

export interface FaceDetection {
  cx: number;
  width: number;
  confidence?: number;
}

export interface PaneState {
  cx: number;
  width: number;
  lastUpdatedAt: number;
}

export interface SplitScreenPanes {
  top: PaneState;
  bottom: PaneState;
}

export interface ResolveSplitScreenSampleOptions {
  t: number;
  detections: FaceDetection[];
  previousPanes: SplitScreenPanes;
  maxHoldSeconds?: number;
}

export function resolveSplitScreenPanes(
  options: ResolveSplitScreenSampleOptions
): SplitScreenPanes {
  const { t, detections, previousPanes } = options;

  if (detections.length >= 2) {
    return matchTwoDetectionsToPanes(detections, previousPanes, t);
  }

  if (detections.length === 1) {
    const [face] = detections;
    const distToTop    = Math.abs(face.cx - previousPanes.top.cx);
    const distToBottom = Math.abs(face.cx - previousPanes.bottom.cx);

    if (distToTop <= distToBottom) {
      return {
        top:    { cx: face.cx, width: face.width, lastUpdatedAt: t },
        bottom: previousPanes.bottom,
      };
    } else {
      return {
        top:    previousPanes.top,
        bottom: { cx: face.cx, width: face.width, lastUpdatedAt: t },
      };
    }
  }

  return { top: previousPanes.top, bottom: previousPanes.bottom };
}

function matchTwoDetectionsToPanes(
  detections: FaceDetection[],
  previousPanes: SplitScreenPanes,
  t: number
): SplitScreenPanes {
  const [a, b] = detections;

  const costAB =
    Math.abs(a.cx - previousPanes.top.cx) +
    Math.abs(b.cx - previousPanes.bottom.cx);
  const costBA =
    Math.abs(b.cx - previousPanes.top.cx) +
    Math.abs(a.cx - previousPanes.bottom.cx);

  if (costAB <= costBA) {
    return {
      top:    { cx: a.cx, width: a.width, lastUpdatedAt: t },
      bottom: { cx: b.cx, width: b.width, lastUpdatedAt: t },
    };
  } else {
    return {
      top:    { cx: b.cx, width: b.width, lastUpdatedAt: t },
      bottom: { cx: a.cx, width: a.width, lastUpdatedAt: t },
    };
  }
}
