import type { SubtitleCue } from './types';

interface Entry {
  cue: SubtitleCue;
  group: number;
  seenAt: number;
  changedAt: number;
  submitted: boolean;
  translation?: string;
  completedAt?: number;
}

/** Bounded delayed pairs. An in-flight source is immutable, including ASR edits. */
export class RealtimeCaptions {
  private entries: Entry[] = [];
  private counter = 0;
  private group = 0;
  private groupStartedAt = 0;
  private text = '';
  private changedAt = 0;
  private shown?: Entry;
  private shownAt = 0;
  private shownOrder = 0;

  clear(): void {
    this.entries = []; this.shown = undefined; this.text = ''; this.shownOrder = this.counter;
  }

  capture(text: string, now: number, timeMs: number): void {
    if (text === this.text) return;
    // Growing/shrinking ASR revisions share a group for at most four seconds.
    // Unrelated text is never merged based on a common word or punctuation.
    const revision = text && this.text && (text.startsWith(this.text) || this.text.startsWith(text))
      && now - this.groupStartedAt < 4000;
    this.text = text; this.changedAt = now;
    if (!text) return;
    if (!revision) { this.group++; this.groupStartedAt = now; }
    const draft = this.entries.findLast(e => e.group === this.group && !e.submitted);
    if (draft) {
      draft.cue = { ...draft.cue, text }; draft.changedAt = now;
    } else {
      this.entries.push({ cue: { id: `d${++this.counter}`, revision: 1, text, context: '', startMs: timeMs, endMs: Number.MAX_SAFE_INTEGER },
        group: this.group, seenAt: now, changedAt: now, submitted: false });
    }
    this.prune(now);
  }

  private prune(now: number): void {
    // Queue age must not discard in-flight text before a slow provider answers.
    // In-flight work is separately bounded by the session's two five-item batches.
    const pending = this.entries.filter(e => e.submitted && !e.translation);
    const other = this.entries.filter(e => !pending.includes(e)
      && (e.cue.text === this.text || now - (e.completedAt ?? e.seenAt) < (e.translation ? 4000 : 12000)))
      .slice(-Math.max(1, 24 - pending.length));
    this.entries = this.entries.filter(e => pending.includes(e) || other.includes(e)).slice(-24);
  }

  candidates(now: number): SubtitleCue[] {
    this.prune(now);
    return this.entries.filter(e => !e.submitted && (now - e.changedAt >= 300 || now - e.seenAt >= 1000)).map(e => e.cue);
  }

  submit(ids: string[]): void {
    for (const e of this.entries) if (ids.includes(e.cue.id)) e.submitted = true;
  }

  complete(id: string, translation: string, now = performance.now()): void {
    const e = this.entries.find(e => e.cue.id === id);
    if (e) { e.translation = translation; e.completedAt = now; }
  }

  display(now: number): { source: string; translation: string } {
    this.prune(now);
    if (!this.text && now - this.changedAt > 1500) {
      this.shown = undefined;
      // Results for a caption cleared during a long silence must not reappear.
      this.shownOrder = this.counter;
      return { source: '', translation: '' };
    }
    const ready = this.entries.filter(e => e.translation && Number(e.cue.id.slice(1)) > this.shownOrder);
    if (ready.length && (!this.shown || now - this.shownAt >= 600)) {
      // Prefer the latest completed revision of the next utterance, but keep
      // different utterances in order. Never regress on out-of-order replies.
      const next = ready.filter(e => e.group === ready[0].group).at(-1)!;
      this.shown = next; this.shownAt = now; this.shownOrder = Number(next.cue.id.slice(1));
    }
    if (this.shown && (this.shown.cue.text === this.text || now - this.shownAt < 4000)) {
      return { source: this.shown.cue.text, translation: this.shown.translation! };
    }
    return { source: this.text, translation: '' };
  }
}
