import { describe, expect, it } from 'vitest';
import { RealtimeCaptions } from '../lib/subtitles/realtime';

function submit(buffer: RealtimeCaptions, now: number) {
  const cues = buffer.candidates(now); buffer.submit(cues.map(c => c.id)); return cues;
}

describe('delayed original/translation pairs', () => {
  it('keeps an earlier pair when native text changes before the next result', () => {
    const b = new RealtimeCaptions();
    b.capture('First sentence', 0, 0); const [first] = submit(b, 400);
    b.capture('Second sentence', 700, 700); const [second] = submit(b, 1100);
    b.complete(first.id, '第一句');
    expect(b.display(1800)).toEqual({ source: 'First sentence', translation: '第一句' });
    b.capture('Third sentence', 1900, 1900);
    expect(b.display(2000)).toEqual({ source: 'First sentence', translation: '第一句' });
    b.complete(second.id, '第二句');
    expect(b.display(2500)).toEqual({ source: 'Second sentence', translation: '第二句' });
  });
  it('coalesces undispatched ASR revisions without mutating in-flight sources', () => {
    const b = new RealtimeCaptions();
    b.capture('The model', 0, 0); b.capture('The model was built', 200, 200);
    const [first] = submit(b, 550);
    expect(first.text).toBe('The model was built');
    b.capture('The model was built with more compute', 700, 700);
    const [second] = submit(b, 1100);
    expect(first.text).toBe('The model was built');
    b.complete(first.id, '模型已建成'); b.complete(second.id, '模型使用了更多算力构建');
    expect(b.display(2000)).toEqual({ source: second.text, translation: '模型使用了更多算力构建' });
  });
  it('does not starve drafts when ASR keeps extending them', () => {
    const b = new RealtimeCaptions();
    for (let i = 0; i <= 5; i++) b.capture('word '.repeat(i + 1), i * 200, i * 200);
    expect(b.candidates(1000)).toHaveLength(1);
  });
  it('never paints an older result after a later pair', () => {
    const b = new RealtimeCaptions();
    b.capture('One', 0, 0); const [one] = submit(b, 400);
    b.capture('Two', 700, 700); const [two] = submit(b, 1100);
    b.complete(two.id, '二'); expect(b.display(2000).source).toBe('Two');
    b.complete(one.id, '一'); expect(b.display(3000).source).toBe('Two');
  });
  it('retains bounded in-flight sources until a slow response is available to display', () => {
    const b = new RealtimeCaptions();
    b.capture('Slow original', 0, 0); const [slow] = submit(b, 400);
    for (let i = 1; i <= 30; i++) b.capture(`Later caption ${i}.`, i * 700, i * 700);
    expect(b.candidates(22000).length).toBeLessThan(24);
    b.complete(slow.id, '较晚返回的译文', 22000);
    expect(b.display(22000)).toEqual({ source: 'Slow original', translation: '较晚返回的译文' });
  });
  it('clears pairs and rejects late results across seek, track or session reset', () => {
    const b = new RealtimeCaptions();
    b.capture('Old', 0, 0); const [old] = submit(b, 400);
    b.clear(); b.capture('New', 700, 80000); b.complete(old.id, '旧');
    expect(b.display(2000)).toEqual({ source: 'New', translation: '' });
    expect(submit(b, 2000)[0].id).not.toBe(old.id);
  });
  it('clears a long silence and does not resurrect captions from delayed replies', () => {
    const b = new RealtimeCaptions();
    b.capture('Gone', 0, 0); const [cue] = submit(b, 400);
    b.capture('', 700, 700); expect(b.display(2500).source).toBe('');
    b.complete(cue.id, '结束'); expect(b.display(3000)).toEqual({ source: '', translation: '' });
  });
  it('bounds backlog and stale-pair display without expiring the current paused caption', () => {
    const b = new RealtimeCaptions();
    for (let i = 0; i < 100; i++) b.capture(`Caption ${i}.`, i * 200, i * 200);
    expect(b.candidates(21000).length).toBeLessThanOrEqual(24);
    const cues = submit(b, 21000); b.complete(cues[0].id, '旧句');
    b.display(21000); expect(b.display(26000).translation).toBe('');
    b.complete(cues.at(-1)!.id, '当前句');
    expect(b.display(35000)).toEqual({ source: 'Caption 99.', translation: '当前句' });
  });
});
