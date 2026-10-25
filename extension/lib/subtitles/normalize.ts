import type { YouTubeCaptionEvent } from './youtube-adapter';
import type { SubtitleCue } from './types';

interface Block { start: number; end: number; text: string; order: number }

/**
 * Deterministic JSON3 normalization. ASR windows replace prior window text;
 * append events extend their window. Whitespace-only rolling-line events do
 * not create duplicate cues. Independent overlapping windows are composed at
 * their time boundaries, never deduplicated by text across different times.
 */
export function normalizeYouTubeEvents(events: YouTubeCaptionEvent[], kind: 'manual' | 'asr'): SubtitleCue[] {
  const blocks: Block[] = [];
  const windows = new Map<number, Block>();
  const sorted = events.map((event, order) => ({ event, order })).sort((a, b) => a.event.tStartMs - b.event.tStartMs || a.order - b.order);
  for (const { event: e, order } of sorted) {
    if (!Number.isFinite(e.tStartMs) || e.tStartMs < 0) continue;
    const text = e.segs?.map(s => s.utf8).join('') ?? '';
    const windowId = e.wWinId ?? 0;
    const previous = windows.get(windowId);
    if (!text.trim()) {
      // Explicit empty window events clear it; ASR newline append events only
      // scroll a line and must not shorten the spoken caption.
      if (e.wWinId != null && !e.aAppend && previous) previous.end = Math.min(previous.end, e.tStartMs);
      continue;
    }
    const duration = e.dDurationMs;
    if (kind === 'asr' && e.aAppend && previous && previous.end >= e.tStartMs) {
      previous.text += text;
      if (duration && Number.isFinite(duration) && duration > 0) previous.end = Math.max(previous.end, e.tStartMs + duration);
      continue;
    }
    // Unknown timing is a capability failure, never silently lost source text.
    if (!duration || !Number.isFinite(duration) || duration <= 0) throw new Error('Caption duration unavailable');
    const end = e.tStartMs + duration;
    if (kind === 'asr' && previous) previous.end = Math.min(previous.end, e.tStartMs);
    const block = { start: e.tStartMs, end, text, order };
    blocks.push(block);
    windows.set(windowId, block);
  }

  const boundaries = new Map<number, { add: Block[]; remove: Block[] }>();
  const boundary = (time: number) => {
    let value = boundaries.get(time);
    if (!value) { value = { add: [], remove: [] }; boundaries.set(time, value); }
    return value;
  };
  for (const block of blocks) {
    if (block.end <= block.start) continue;
    boundary(block.start).add.push(block);
    boundary(block.end).remove.push(block);
  }
  const times = [...boundaries.keys()].sort((a, b) => a - b);
  const active = new Set<Block>();
  const cues: SubtitleCue[] = [];
  let totalText = 0;
  for (let i = 0; i < times.length - 1; i++) {
    const startMs = times[i];
    const changes = boundaries.get(startMs)!;
    for (const block of changes.remove) active.delete(block);
    for (const block of changes.add) active.add(block);
    if (active.size > 16) throw new Error('Too many simultaneous caption windows');
    const text = [...active].sort((a, b) => a.order - b.order).map(b => b.text.trim()).join('\n');
    if (!text) continue;
    totalText += text.length;
    if (totalText > 4 * 1024 * 1024) throw new Error('Normalized caption budget exceeded');
    cues.push({ id: `c${cues.length}-${startMs}`, revision: 1, startMs, endMs: times[i + 1], text, context: '' });
  }
  for (let i = 0; i < cues.length; i++) {
    cues[i].context = [cues[i - 1]?.text.slice(-400), cues[i + 1]?.text.slice(0, 400)].filter(Boolean).join('\n');
  }
  return cues;
}

/** Normalization produces disjoint intervals. Gaps return null, never last cue. */
export function cueAt(cues: SubtitleCue[], timeMs: number): SubtitleCue | null {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cues[mid].startMs <= timeMs) lo = mid + 1;
    else hi = mid;
  }
  const cue = cues[lo - 1];
  return cue && timeMs >= cue.startMs && timeMs < cue.endMs ? cue : null;
}

export function nearbyCues(cues: SubtitleCue[], timeMs: number, playbackRate: number): SubtitleCue[] {
  const horizon = timeMs + Math.min(60_000, 30_000 * Math.max(1, playbackRate));
  return cues.filter(c => c.endMs > timeMs && c.startMs <= horizon).slice(0, 24);
}
