import { OURS_SEL } from '../dom-const';
import { walkOpenShadowRoots } from '../roots';

/** Keep original node identity while distinguishing page edits from filled slots. */
export interface RichReplacementNode {
  node: Node;
  original: Node;
  /** Actual source parent, including wrappers omitted from the safe skeleton. */
  originalParent: Node | null;
  value: string | null;
  /** Filled skeleton attributes, so only later page edits return to the source. */
  attributes?: Map<string, AttributeState>;
  children: RichReplacementNode[];
  /** A missed transfer cannot justify deleting its last known source. */
  unresolvedValue?: string | null;
  explicitReplacement?: boolean;
}

interface AttributeState {
  namespace: string | null;
  name: string;
  localName: string;
  value: string;
}

interface TextRun {
  host: HTMLElement;
  items: RichReplacementNode[];
  filled: string;
}

type TextBoundary = Pick<RichReplacementNode, 'node' | 'value'>;
interface TextMerge {
  parent: Node;
  anchor: Node;
  fragments: TextBoundary[];
  items: TextBoundary[];
  filled: string;
}
interface TextHistory {
  document: Document;
  observer: MutationObserver;
  hosts: Set<WeakRef<HTMLElement>>;
  detached: Set<WeakRef<HTMLElement>>;
  roots: Set<WeakRef<ShadowRoot>>;
  gaps: Set<WeakRef<Node>>;
  missing: Set<WeakRef<RichReplacementNode>>;
  gapRefs: WeakMap<Node, WeakRef<Node>>;
  missingRefs: WeakMap<RichReplacementNode, WeakRef<RichReplacementNode>>;
}

// Weak keys keep moved copies recoverable across hosts without retaining pages.
const copies = new WeakMap<Node, { host: HTMLElement; saved: RichReplacementNode; run?: TextRun; mergedValue?: string | null }>();
const textRuns = new WeakMap<Node, TextRun[]>();
const textHistories = new WeakMap<Node, TextHistory>();
const documentHistories = new WeakMap<Document, TextHistory>();
const historyHosts = new WeakMap<Node, WeakRef<HTMLElement>>();
const mergedTexts = new WeakMap<Node, TextMerge[]>();
const mergedParents = new WeakMap<Node, TextMerge[]>();

/** Replay one characterData edit against the boundaries of a proven merge. */
function editTextMerge(node: Node, before: string, after: string): void {
  for (const merge of [...mergedTexts.get(node) ?? []]) {
    const fragment = merge.fragments.find((item) => item.node === node);
    if (!fragment || fragment.value !== before || before === after) continue;
    const offset = merge.fragments.slice(0, merge.fragments.indexOf(fragment))
      .reduce((n, item) => n + (item.value?.length ?? 0), 0);
    const previous = merge.filled;
    const next = previous.slice(0, offset) + after + previous.slice(offset + before.length);
    // A complete replacement is new source, rather than retained slots.
    if (!merge.items.some((item) => copies.has(item.node) && item.value && next.includes(item.value))) {
      const edited = copies.get(node);
      if (edited) edited.mergedValue = after;
      for (const item of merge.items) {
        const copy = copies.get(item.node);
        if (copy && item.node !== node && !item.node.parentNode) copy.saved.explicitReplacement = true;
      }
      forgetTextMerge(merge);
      continue;
    }
    // A split physical Text still identifies which part was edited, even if
    // different source slots have identical translations.
    let start = offset;
    while (start < offset + before.length && start < offset + after.length && previous[start] === next[start]) start++;
    let suffix = previous.length - offset - before.length;
    while (suffix < previous.length - start && suffix < next.length - start
      && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
    // A shared translation prefix must not split an untouched neighboring
    // slot. For example, deleting A from "译:A译:B" retains the whole B slot.
    let prefixSlots = 0;
    for (const item of merge.items) {
      const value = item.value ?? '';
      if (!next.startsWith(value, prefixSlots)) break;
      prefixSlots += value.length;
    }
    let suffixSlots = 0;
    for (const item of [...merge.items].reverse()) {
      const value = item.value ?? '';
      if (prefixSlots + suffixSlots + value.length > next.length
        || !next.endsWith(value, next.length - suffixSlots)) break;
      suffixSlots += value.length;
    }
    suffix = Math.min(Math.max(suffix, suffixSlots), previous.length - offset, next.length - offset);
    start = Math.min(start, previous.length - suffix, next.length - suffix);
    const end = previous.length - suffix;
    const inserted = next.slice(start, next.length - suffix);
    let boundary = 0;
    const ambiguous = end > start && merge.items.some((item) => {
      const alternative = boundary;
      boundary += item.value?.length ?? 0;
      return alternative !== start && alternative >= offset && alternative + end - start <= offset + before.length
        && previous.slice(0, alternative) + inserted + previous.slice(alternative + end - start) === next;
    });
    if (ambiguous) {
      // Repeated filled values can hide which source slot a range edit deleted.
      // Keep the source and the page's current Text independently; never assign
      // that edit to an arbitrary equal-valued slot.
      const cuts = new Map<number, number>([[0, 0]]);
      let logicalOffset = 0;
      merge.items.forEach((item, i) => { logicalOffset += item.value?.length ?? 0; cuts.set(logicalOffset, i + 1); });
      const first = cuts.get(offset);
      const last = cuts.get(offset + before.length);
      const bounded = first !== undefined && last !== undefined && logicalOffset === previous.length;
      for (const item of bounded ? merge.items.slice(first, last) : merge.items) {
        const copy = copies.get(item.node);
        if (copy) copy.saved.unresolvedValue = item.value;
        copies.delete(item.node);
      }
      forgetTextMerge(merge);
      if (bounded) {
        // Other physical fragments still prove their source slots. Limit the
        // conservative fallback to the fragment whose edit is ambiguous.
        const at = merge.fragments.indexOf(fragment);
        for (const side of [
          { fragments: merge.fragments.slice(0, at), items: merge.items.slice(0, first), filled: previous.slice(0, offset) },
          { fragments: merge.fragments.slice(at + 1), items: merge.items.slice(last), filled: previous.slice(offset + before.length) },
        ]) {
          if (!side.fragments.length || !side.items.some(item => copies.has(item.node))) continue;
          rememberTextMerge({ ...side, parent: merge.parent, anchor: side.fragments[0].node });
        }
      }
      continue;
    }
    let position = 0;
    let assigned = false;
    for (const item of merge.items) {
      const value = item.value ?? '';
      const stop = position + value.length;
      const prefix = value.slice(0, Math.max(0, Math.min(value.length, start - position)));
      const tail = value.slice(Math.max(0, end - position));
      // Insertions at a boundary stay on the preceding slot; replacing the
      // next slot's content belongs to that next slot instead.
      const ownsEdit: boolean = !assigned && (start < stop || start === stop && start === end);
      item.value = prefix + (ownsEdit ? inserted : '') + tail;
      const copy = copies.get(item.node);
      if (copy) copy.mergedValue = item.value;
      if (ownsEdit) assigned = true;
      position = stop;
    }
    fragment.value = after;
    merge.filled = next;
  }
}

function splitTextMerge(node: Node, tail: TextBoundary, before: string, after: string): void {
  if (!mergedTexts.has(node) && copies.has(node)) {
    // A single retained slot also needs provenance when splitText(0) moves
    // all its content and leaves only an empty copied Text at the old parent.
    rememberTextMerge({
      parent: node.parentNode ?? node.ownerDocument!, anchor: node,
      fragments: [{ node, value: before }], items: [{ node, value: before }], filled: before,
    });
  }
  for (const merge of mergedTexts.get(node) ?? []) {
    const at = merge.fragments.findIndex((item) => item.node === node && item.value === before);
    if (at < 0) continue;
    merge.fragments.splice(at, 1, { node, value: after }, { ...tail });
    mergedTexts.set(tail.node, [...mergedTexts.get(tail.node) ?? [], merge]);
  }
}

/** Record proven concatenations, then replay later edits in mutation order. */
function recordTextMerges(records: MutationRecord[]): void {
  if (!records.some((record) => record.type === 'characterData' && (copies.has(record.target) || mergedTexts.has(record.target))
    || Array.from(record.removedNodes).some((node) => node instanceof Text && (copies.has(node) || mergedTexts.has(node))))) return;
  const values = new Map<Node, string>();
  const after = new Map<MutationRecord, string>();
  const removed = new Map<MutationRecord, TextBoundary[]>();
  const added = new Map<MutationRecord, TextBoundary[]>();
  // A later characterData record carries the value after an earlier edit.
  // Snapshot removed nodes at the removal, even if page code later edits them.
  for (const record of [...records].reverse()) {
    if (record.type === 'characterData') {
      after.set(record, values.get(record.target) ?? record.target.nodeValue ?? '');
      values.set(record.target, record.oldValue ?? '');
    } else {
      removed.set(record, Array.from(record.removedNodes).filter((node) => node instanceof Text)
        .map((node) => ({ node, value: values.get(node) ?? node.nodeValue ?? '' })));
      added.set(record, Array.from(record.addedNodes).filter((node) => node instanceof Text)
        .map((node) => ({ node, value: values.get(node) ?? node.nodeValue ?? '' })));
    }
  }
  const updates = new Map<Node, { parent?: Node; before: string; after: string; removed: TextBoundary[] }>();
  const splits = new Map<Node, TextBoundary>();
  const removedNodes = new Set<Node>();
  const finish = (node: Node): void => {
    const update = updates.get(node);
    if (!update?.parent || !update.removed.some((item) => copies.has(item.node) || mergedTexts.has(item.node))) return;
    if (update.after !== update.before + update.removed.map((item) => item.value).join('')) return;
    // Once the concatenation is proven, later independent removals must not
    // invalidate it merely because they have the same previous sibling.
    updates.delete(node);
    // A tail may have been edited immediately before this normalization.
    // Replay that edit before matching and flattening its recorded fragments.
    for (const item of update.removed) commit(item.node);
    const items: TextBoundary[] = [];
    const parts = [{ node, value: update.before }, ...update.removed];
    for (let i = 0; i < parts.length; i++) {
      const item = parts[i];
      // A split fragment can normalize with another host before restoration.
      // Resolve its complete logical slots before flattening the next merge.
      for (const merge of [...mergedTexts.get(item.node) ?? []]) {
        partitionTextMerge(merge, { parent: update.parent, parts });
      }
      // Flatten earlier merges so edits after another normalize still address
      // each original slot, including slots from a different source host.
      const prior = mergedTexts.get(item.node)?.findLast((merge) => merge.fragments.every((part, offset) =>
        part.node === parts[i + offset]?.node && part.value === parts[i + offset]?.value));
      if (prior) {
        items.push(...prior.items.map((part) => ({ ...part })));
        i += prior.fragments.length - 1;
        forgetTextMerge(prior);
      } else if (!items.length || copies.has(item.node)) items.push({ ...item });
      // normalize discarded page-owned Text identity. Carry its source text on
      // the preceding slot, as for ordinary appendData, without reviving it.
      else items.at(-1)!.value += item.value ?? '';
    }
    const existing = mergedParents.get(update.parent) ?? [];
    if (existing.some((merge) => merge.anchor === node && merge.filled === update.after
      && merge.items.length === items.length && merge.items.every((item, i) => item.node === items[i].node && item.value === items[i].value))) return;
    const merge = { parent: update.parent, anchor: node, fragments: [{ node, value: update.after }], items, filled: update.after };
    rememberTextMerge(merge);
  };
  const commit = (node: Node): void => {
    finish(node);
    const update = updates.get(node);
    if (!update) return;
    if (!mergedTexts.has(node)) {
      const copy = copies.get(node);
      if (copy) copy.mergedValue = update.after;
    }
    editTextMerge(node, update.before, update.after);
    updates.delete(node);
  };
  for (const record of records) {
    if (record.type === 'characterData') {
      commit(record.target);
      // Native observers report edits to removed subtrees until delivery.
      // Editing a discarded Text must not edit the slots now carried by its
      // normalized survivor, or erase their last known source value.
      if (removedNodes.has(record.target) && !record.target.isConnected) continue;
      const tail = splits.get(record.target);
      splits.delete(record.target);
      if (tail && record.oldValue === after.get(record)! + tail.value) {
        splitTextMerge(record.target, tail, record.oldValue, after.get(record)!);
        continue;
      }
      updates.set(record.target, { before: record.oldValue ?? '', after: after.get(record)!, removed: [] });
    } else if (record.addedNodes.length === 1 && !record.removedNodes.length) {
      removedNodes.delete(record.addedNodes[0]);
      const tail = added.get(record)?.[0];
      const node = record.previousSibling;
      const update = node && updates.get(node);
      // splitText changes physical fragments without editing their joined text.
      if (node && update && tail && update.before === update.after + tail.value) {
        splitTextMerge(node, tail, update.before, update.after);
        updates.delete(node);
      } else if (node && tail) splits.set(node, tail);
    } else if (!record.addedNodes.length) {
      const update = record.previousSibling && updates.get(record.previousSibling);
      if (update) {
        update.parent = record.target;
        update.removed.push(...removed.get(record) ?? []);
        finish(record.previousSibling!);
      }
    }
    if (record.type === 'childList') {
      for (const node of record.removedNodes) removedNodes.add(node);
      for (const node of record.addedNodes) removedNodes.delete(node);
    }
  }
  for (const node of updates.keys()) commit(node);
}

const textObserverOptions: MutationObserverInit = {
  childList: true, subtree: true, characterData: true, characterDataOldValue: true,
};

function watchShadowRoot(history: TextHistory, root: ShadowRoot): void {
  if ([...history.roots].some((ref) => ref.deref() === root)) return;
  history.roots.add(new WeakRef(root));
  history.observer.observe(root, textObserverOptions);
}

function recordObservationGap(history: TextHistory, node: Node): void {
  let ref = history.gapRefs.get(node);
  if (!ref) { ref = new WeakRef(node); history.gapRefs.set(node, ref); }
  history.gaps.add(ref);
}

function recordUnobservedTexts(history: TextHistory, node: Node, children?: Map<Node, Set<Node>>): void {
  if (node instanceof Element && node.matches(OURS_SEL) || copies.has(node)) return;
  if (node instanceof Text) { recordObservationGap(history, node); return; }
  for (const child of children?.get(node) ?? node.childNodes) recordUnobservedTexts(history, child, children);
}

function consumeTextRecords(history: TextHistory, records: MutationRecord[]): void {
  recordTextMerges(records);
  for (const record of records) for (const node of record.removedNodes) {
    const copy = copies.get(node);
    if (!(node instanceof Text) || !copy) continue;
    let ref = history.missingRefs.get(copy.saved);
    if (!ref) { ref = new WeakRef(copy.saved); history.missingRefs.set(copy.saved, ref); }
    history.missing.add(ref);
    if (!record.addedNodes.length) continue;
    copy.saved.explicitReplacement = true;
    for (const merge of mergedTexts.get(node) ?? []) for (const item of merge.items) {
      const related = copies.get(item.node);
      if (related) related.saved.explicitReplacement = true;
    }
  }
  // Reconstruct which Texts were already present when a subtree was added.
  // Later observed insertions into an empty wrapper are known page edits, not
  // gaps: equal-valued Texts there must not revive an independently deleted slot.
  if (!records.some(record => Array.from(record.addedNodes)
    .some(node => node instanceof Element && !node.matches(OURS_SEL) && !copies.has(node)))) return;
  const children = new Map<Node, Set<Node>>();
  for (const record of [...records].reverse()) {
    if (record.type !== 'childList') continue;
    let before = children.get(record.target);
    if (!before) { before = new Set(record.target.childNodes); children.set(record.target, before); }
    for (const node of record.addedNodes) before.delete(node);
    for (const node of record.removedNodes) before.add(node);
    for (const node of record.addedNodes) {
      if (!(node instanceof Element) || node.matches(OURS_SEL) || copies.has(node)) continue;
      recordUnobservedTexts(history, node, children);
      for (const root of walkOpenShadowRoots(node)) {
        if (![...history.roots].some((ref) => ref.deref() === root)) recordUnobservedTexts(history, root, children);
        watchShadowRoot(history, root);
      }
    }
  }
}

/** Keep source at its original position; equal text cannot prove a new owner. */
function preserveUnobservedSource(history: TextHistory): void {
  const pending: { saved: RichReplacementNode; value: string }[] = [];
  for (const ref of history.missing) {
    const saved = ref.deref();
    const copy = saved && copies.get(saved.node);
    if (saved && copy && saved.node.isConnected) {
      delete saved.unresolvedValue;
      delete saved.explicitReplacement;
    }
    if (!saved || !copy || saved.node.isConnected || saved.explicitReplacement) {
      history.missing.delete(ref);
      continue;
    }
    const value = copy.mergedValue ?? saved.node.nodeValue;
    if (value) pending.push({ saved, value });
  }
  const candidates: string[] = [];
  for (const ref of pending.length ? history.gaps : []) {
    const node = ref.deref();
    if (!node?.isConnected || copies.has(node) || node.parentElement?.closest(OURS_SEL)) continue;
    if (node.nodeValue) candidates.push(node.nodeValue);
  }
  history.gaps.clear();
  for (const { saved, value } of pending) {
    if (candidates.some((candidate) => candidate.includes(value))) saved.unresolvedValue = value;
  }
}

function observeTextHistory(history: TextHistory): void {
  history.observer.observe(history.document, textObserverOptions);
  for (const ref of history.roots) {
    const root = ref.deref();
    if (root) history.observer.observe(root, textObserverOptions);
  }
  for (const ref of history.detached) {
    const host = ref.deref();
    if (host && !host.isConnected) history.observer.observe(host, textObserverOptions);
  }
}

function disconnectTextHistory(history: TextHistory): void {
  history.observer.disconnect();
  if (documentHistories.get(history.document) === history) documentHistories.delete(history.document);
}

function pruneTextHistory(history: TextHistory): void {
  for (const ref of history.hosts) if (!ref.deref()) history.hosts.delete(ref);
  for (const ref of history.detached) {
    const host = ref.deref();
    if (!host || host.isConnected) history.detached.delete(ref);
  }
  for (const ref of history.gaps) if (!ref.deref()?.isConnected) history.gaps.delete(ref);
  for (const ref of history.missing) {
    const saved = ref.deref();
    if (!saved || !copies.has(saved.node) || saved.node.isConnected) history.missing.delete(ref);
  }
  if (!history.hosts.size) {
    disconnectTextHistory(history);
    return;
  }
  let changed = false;
  for (const ref of history.roots) {
    if (!ref.deref()?.host.isConnected) {
      history.roots.delete(ref);
      changed = true;
    }
  }
  if (changed) {
    history.observer.disconnect();
    observeTextHistory(history);
  }
}

function watchTextParent(parent: HTMLElement): void {
  const doc = parent.ownerDocument;
  let history = documentHistories.get(doc);
  if (!history) {
    const created: TextHistory = {
      document: doc,
      observer: new MutationObserver((records) => {
        consumeTextRecords(created, records);
        pruneTextHistory(created);
      }),
      hosts: new Set(), detached: new Set(), roots: new Set(), gaps: new Set(), missing: new Set(),
      gapRefs: new WeakMap(), missingRefs: new WeakMap(),
    };
    history = created;
    documentHistories.set(doc, history);
    observeTextHistory(history);
    for (const root of walkOpenShadowRoots(doc)) watchShadowRoot(history, root);
  }
  const existing = historyHosts.get(parent);
  if (existing) {
    textHistories.get(parent)?.hosts.delete(existing);
    textHistories.get(parent)?.detached.delete(existing);
  }
  const ref = new WeakRef(parent);
  historyHosts.set(parent, ref);
  history.hosts.add(ref);
  textHistories.set(parent, history);
  consumeTextRecords(history, history.observer.takeRecords());
  const root = parent.getRootNode();
  if (root instanceof ShadowRoot) watchShadowRoot(history, root);
  else if (!parent.isConnected) {
    history.detached.add(ref);
    history.observer.observe(parent, textObserverOptions);
  }
}

function forgetTextParent(parent: Node): void {
  const history = textHistories.get(parent);
  const ref = historyHosts.get(parent);
  if (history && ref) {
    history.hosts.delete(ref);
    history.detached.delete(ref);
    // Restoring many hosts must not sweep every remaining owner per host.
    if (!history.hosts.size) disconnectTextHistory(history);
  }
  historyHosts.delete(parent);
  textHistories.delete(parent);
  textRuns.delete(parent);
  mergedParents.delete(parent);
}

export function captureRichReplacement(
  root: Node,
  originals: ReadonlyMap<Node, Node>,
  host: HTMLElement,
): RichReplacementNode[] {
  const saved = captureChildren(root, originals, host);
  // The skeleton's top-level children are inserted into the real host.
  const runs = textRuns.get(root) ?? [];
  forgetTextParent(root);
  textRuns.set(host, runs);
  watchTextParent(host);
  return saved;
}

/** Release the live host's text-run index even if the page removed its stash. */
export function forgetRichReplacement(host: HTMLElement): void {
  forgetTextParent(host);
}

function captureChildren(root: Node, originals: ReadonlyMap<Node, Node>, host: HTMLElement): RichReplacementNode[] {
  const saved = Array.from(root.childNodes).map((node) => {
    const saved: RichReplacementNode = {
      node,
      original: originals.get(node)!,
      originalParent: originals.get(node)!.parentNode,
      value: node.nodeValue,
      attributes: node instanceof Element ? readAttributes(node) : undefined,
      children: captureChildren(node, originals, host),
    };
    copies.set(node, { host, saved, mergedValue: node instanceof Text ? saved.value : undefined });
    return saved;
  });
  const runs: TextRun[] = [];
  let run: TextRun | undefined;
  for (const item of saved) {
    if (item.node.nodeType !== Node.TEXT_NODE) { run = undefined; continue; }
    if (!run) { run = { host, items: [], filled: '' }; runs.push(run); }
    run.items.push(item);
    run.filled += item.value ?? '';
    copies.get(item.node)!.run = run;
  }
  if (runs.length) {
    textRuns.set(root, runs);
  }
  return saved;
}

function currentTextRuns(parent: Node): Text[][] {
  const runs: Text[][] = [];
  let run: Text[] | undefined;
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== Node.TEXT_NODE) { run = undefined; continue; }
    if (!run) { run = []; runs.push(run); }
    run.push(node as Text);
  }
  return runs;
}

/** splitText/normalize change boundaries, not the retained translation. */
function readTextHistory(parent: Node): void {
  const history = textHistories.get(parent) ?? (parent instanceof Document ? documentHistories.get(parent) : undefined);
  if (history) consumeTextRecords(history, history.observer.takeRecords());
}

function forgetTextMerge(merge: TextMerge): void {
  for (const [index, key] of [
    ...merge.fragments.map((item) => [mergedTexts, item.node] as const),
    [mergedParents, merge.parent] as const,
  ]) {
    const remaining = index.get(key)?.filter((item) => item !== merge) ?? [];
    if (remaining.length) index.set(key, remaining);
    else index.delete(key);
  }
}

function rememberTextMerge(merge: TextMerge): void {
  mergedParents.set(merge.parent, [...mergedParents.get(merge.parent) ?? [], merge]);
  for (const fragment of merge.fragments) {
    mergedTexts.set(fragment.node, [...mergedTexts.get(fragment.node) ?? [], merge]);
  }
  for (const item of merge.items) {
    const copy = copies.get(item.node);
    if (copy) copy.mergedValue = item.value;
  }
}

/** Independent physical runs can still contain complete, proven source slots. */
function partitionTextMerge(merge: TextMerge, joining?: { parent: Node; parts: TextBoundary[] }): TextMerge[] {
  if (merge.fragments.length < 2) return [merge];
  const cuts = new Map<number, number>([[0, 0]]);
  let offset = 0;
  // Empty logical slots occupy no characters. Their repeated cut belongs to
  // the following retained slot, so a split at zero can still move that slot.
  merge.items.forEach((item, i) => { offset += item.value!.length; cuts.set(offset, i + 1); });
  if (offset !== merge.filled.length) return [merge];
  const groups: { parent: Node | null; fragments: TextBoundary[]; start: number; end: number }[] = [];
  offset = 0;
  for (const fragment of merge.fragments) {
    // normalize() has already removed its later fragments by the time records
    // are read. The proven concatenation identifies their parent and order.
    const joiningAt = joining?.parts.findIndex((item) => item.node === fragment.node) ?? -1;
    const parent = joiningAt >= 0 ? joining!.parent : fragment.node.parentNode;
    let group = groups.at(-1);
    const previous = group?.fragments.at(-1)?.node;
    const previousAt = joining?.parts.findIndex((item) => item.node === previous) ?? -1;
    const adjacent = joiningAt >= 0 && previousAt >= 0
      ? joiningAt === previousAt + 1 : previous?.nextSibling === fragment.node;
    if (!group || group.parent !== parent || parent && !adjacent) {
      group = { parent, fragments: [], start: offset, end: offset };
      groups.push(group);
    }
    group.fragments.push(fragment);
    offset += fragment.value?.length ?? 0;
    group.end = offset;
  }
  // Translation characters do not describe original character offsets. Only
  // split at known slot boundaries; an internal split stays one logical slot.
  if (groups.length < 2 || offset !== merge.filled.length
    || groups.some((group) => !cuts.has(group.start) || !cuts.has(group.end))) return [merge];
  forgetTextMerge(merge);
  const parts: TextMerge[] = [];
  for (const group of groups) {
    if (!group.parent) continue; // A real page removal must stay removed.
    if (group.start === group.end) {
      // splitText(0) leaves an empty copy behind while its entire slot moves.
      // Release that placeholder so it cannot pin the source to the old host.
      for (const { node } of group.fragments) if (copies.has(node) && node.nodeValue === '') node.parentNode?.removeChild(node);
      continue;
    }
    const part: TextMerge = {
      parent: group.parent, anchor: group.fragments[0].node,
      fragments: group.fragments.map((item) => ({ ...item })),
      items: merge.items.slice(cuts.get(group.start), cuts.get(group.end)).map((item) => ({ ...item })),
      filled: merge.filled.slice(group.start, group.end),
    };
    rememberTextMerge(part);
    parts.push(part);
  }
  return parts;
}

function recoverTextRuns(parent: Node, incoming?: TextRun, moved?: TextMerge[]): void {
  readTextHistory(parent);
  const registered = textRuns.get(parent);
  if (!registered?.length && !incoming && !mergedParents.has(parent) && !moved?.length) return;
  const origins = new Set([...(registered?.map((run) => run.host) ?? []), ...(incoming ? [incoming.host] : [])]);
  for (const origin of origins) readTextHistory(origin);
  const merges = new Set([...mergedParents.get(parent) ?? [], ...moved ?? []]);
  for (const current of currentTextRuns(parent)) {
    for (const node of current) for (const merge of mergedTexts.get(node) ?? []) merges.add(merge);
  }
  // A merged survivor can move again. Keep its history on the Text itself so
  // its current parent can recover it after the original container is gone.
  for (const merge of [...merges].reverse()) {
    for (const part of partitionTextMerge(merge)) {
      const destination = part.fragments[0]?.node.parentNode ?? parent;
      if (part.items.some((item) => copies.has(item.node)) && recoverTextSequence(destination, part.items, part.filled, part.fragments)) {
        forgetTextMerge(part);
      }
    }
  }
  const candidates = new Set(registered);
  if (incoming) candidates.add(incoming);
  for (const saved of candidates) {
    if (!saved.filled) continue;
    const live = saved.items.filter((item) => copies.has(item.node) && item.node.parentNode === parent);
    if (live.length === saved.items.length) recoverTextSequence(parent, saved.items, saved.filled);
    // Missing copies need proven merge history. Equal-valued page Texts must
    // not revive deleted slots alongside a retained neighboring copy.
    else for (const item of live) if (item.value) recoverTextSequence(parent, [item], item.value);
  }
}

function recoverTextSequence(parent: Node, items: TextBoundary[], filled: string, fragments?: TextBoundary[]): boolean {
  for (const current of currentTextRuns(parent)) {
    const members = new Set(items.map((item) => item.node));
    // Matching text alone cannot prove ownership after a page replaced every
    // copied Text. Require a live copy or recorded physical fragments.
    if (!fragments && !items.some((item) => current.includes(item.node as Text))) continue;
    // A page transfer/removal is not a merge: never reclaim a live sibling
    // elsewhere, nor rebuild a run whose original slot boundaries survived.
    if (items.some((item) => item.node.parentNode && !current.includes(item.node as Text))) continue;
    if (items.every((item) => current.includes(item.node as Text)
      && (item.node.nodeValue ?? '').includes(item.value ?? ''))) return true;
    const joined = current.map((node) => node.data).join('');
    let offset = 0;
    const ranges = current.map((node) => {
      const start = offset;
      offset += node.length;
      return { node, start, end: offset };
    });
    let at: number;
    if (fragments) {
      const first = current.indexOf(fragments[0].node as Text);
      if (first < 0 || fragments.some((fragment, i) => current[first + i] !== fragment.node)) continue;
      const start = current.slice(0, first).reduce((n, node) => n + node.length, 0);
      const physical = fragments.map((fragment) => fragment.node.nodeValue ?? '').join('');
      const within = physical.indexOf(filled);
      if (within < 0) continue;
      at = start + within;
    } else {
      const slots = new Map<Node, number>();
      let start = 0;
      for (const item of items) { slots.set(item.node, start); start += item.value?.length ?? 0; }
      const retained = ranges.filter(({ node }) => members.has(node));
      at = joined.indexOf(filled);
      // A preceding page Text may have exactly the same value. Locate the
      // retained copies, rather than taking the first string occurrence.
      while (at >= 0 && retained.some(({ node, start, end }) => start === end
        ? start !== at + slots.get(node)!
        : start >= at + filled.length || end <= at)) at = joined.indexOf(filled, at + 1);
    }
    if (at < 0) continue;
    const end = at + filled.length;
    if (ranges.some(({ node, start, end: stop }) => start < end && stop > at
      && copies.has(node) && !members.has(node))) continue;

    // One shared observer follows transfers throughout the document and known
    // shadow roots. Drain and pause each affected document once for our writes.
    const histories = new Set<TextHistory>();
    const local = documentHistories.get(parent.ownerDocument ?? parent as Document);
    if (local) histories.add(local);
    for (const item of items) {
      const owner = copies.get(item.node)?.host;
      const history = owner && textHistories.get(owner);
      if (history) histories.add(history);
    }
    for (const history of histories) {
      consumeTextRecords(history, history.observer.takeRecords());
      history.observer.disconnect();
    }
    try {
      const before: Node[] = [];
      const after: Node[] = [];
      const residuals = new Set<Node>();
      for (const { node, start, end: stop } of ranges) {
        const prefix = node.data.slice(0, Math.max(0, Math.min(node.length, at - start)));
        const suffix = node.data.slice(Math.max(0, end - start));
        if (members.has(node)) {
          for (const [text, nodes] of [[prefix, before], [suffix, after]] as const) {
            if (!text) continue;
            const residual = node.ownerDocument.createTextNode(text);
            residuals.add(residual);
            nodes.push(residual);
          }
        } else if (stop <= at) before.push(node);
        else if (start >= end) after.push(node);
        else {
          // Preserve page-owned text outside the identified filled range.
          if (prefix) { node.data = prefix; before.push(node); }
          if (suffix) {
            const tail = prefix ? node.ownerDocument.createTextNode(suffix) : node;
            tail.data = suffix;
            after.push(tail);
          }
        }
      }
      for (const item of items) item.node.nodeValue = item.value;
      // Keep edits on their original Text when they border the filled range.
      if (residuals.has(before.at(-1)!)) {
        items[0].node.nodeValue = before.pop()!.nodeValue + items[0].value!;
      }
      if (residuals.has(after[0])) {
        items.at(-1)!.node.nodeValue += after.shift()!.nodeValue!;
      }
      const anchor = current.at(-1)!.nextSibling;
      const result = [...before, ...items.map((item) => item.node), ...after];
      for (const node of result) parent.insertBefore(node, anchor);
      for (const node of current) if (!result.includes(node)) parent.removeChild(node);
    } finally {
      for (const history of histories) if (history.hosts.size) observeTextHistory(history);
    }
    return true;
  }
  return false;
}

function recoverTextTree(node: Node): void {
  if (node instanceof Element && node.matches(OURS_SEL)) return;
  recoverTextRuns(node);
  for (const child of Array.from(node.childNodes)) {
    const run = copies.get(child)?.run;
    if (run && !textRuns.get(node)?.includes(run)) recoverTextRuns(node, run);
    recoverTextTree(child);
  }
}

function sourceChild(node: Node, parent: Node): Node | null {
  while (node.parentNode && node.parentNode !== parent) node = node.parentNode;
  return node.parentNode === parent ? node : null;
}

interface ReplacementTree {
  byNode: Map<Node, RichReplacementNode>;
  present: Set<Node>;
}

function indexSaved(nodes: RichReplacementNode[], byNode: ReplacementTree['byNode']): void {
  for (const item of nodes) {
    if (item.unresolvedValue === undefined) byNode.set(item.node, item);
    indexSaved(item.children, byNode);
  }
}

function collectPresent(node: Node, tree: ReplacementTree): void {
  tree.present.add(node);
  const copy = copies.get(node);
  if (copy && !tree.byNode.has(node)) indexSaved([copy.saved], tree.byNode);
  for (const child of Array.from(node.childNodes)) collectPresent(child, tree);
}

function replacementTree(saved: RichReplacementNode[], current: Node[]): ReplacementTree {
  const tree: ReplacementTree = { byNode: new Map(), present: new Set() };
  indexSaved(saved, tree.byNode);
  for (const node of current) collectPresent(node, tree);
  return tree;
}

function readAttributes(node: Element): Map<string, AttributeState> {
  return new Map(Array.from(node.attributes, (attr) => [
    `${attr.namespaceURI ?? ''}\u0000${attr.localName}`,
    { namespace: attr.namespaceURI, name: attr.name, localName: attr.localName, value: attr.value },
  ]));
}

function restoreNodeEdits(item: RichReplacementNode, value = item.node.nodeValue): void {
  if (item.attributes && item.node instanceof Element && item.original instanceof Element) {
    const current = readAttributes(item.node);
    for (const [key, attr] of item.attributes) {
      if (current.has(key)) continue;
      if (attr.namespace) item.original.removeAttributeNS(attr.namespace, attr.localName);
      else item.original.removeAttribute(attr.name);
    }
    for (const [key, attr] of current) {
      if (item.attributes.get(key)?.value === attr.value) continue;
      if (attr.namespace) item.original.setAttributeNS(attr.namespace, attr.name, attr.value);
      else item.original.setAttribute(attr.name, attr.value);
    }
  }
  if (value === item.value) return;
  const filled = item.value;
  // A complete retained translation surrounded by new text is an incremental
  // edit. Carry only the added text back to the source. Otherwise the page
  // supplied a complete replacement, which becomes the new source value.
  const at = filled ? value?.indexOf(filled) ?? -1 : -1;
  item.original.nodeValue = at >= 0
    ? value!.slice(0, at) + (item.original.nodeValue ?? '') + value!.slice(at + filled!.length)
    : value;
}

function discardCopies(tree: ReplacementTree): void {
  for (const node of tree.present) {
    if (!tree.byNode.has(node)) continue;
    node.parentNode?.removeChild(node);
    copies.delete(node);
    mergedTexts.delete(node);
    forgetTextParent(node);
  }
}

function restoreEscapedChildren(saved: RichReplacementNode[], parent: Node): void {
  for (const item of saved) {
    if (item.node.isConnected && !parent.contains(item.node)) restoreCopy(item);
    else restoreEscapedChildren(item.children, parent);
  }
}

function restoreCopy(item: RichReplacementNode): void {
  if (!copies.has(item.node)) return;
  recoverTextTree(item.node);
  // Recover split subtrees before moving their old parent. This also handles
  // ancestors placed under former descendants without creating a DOM cycle.
  restoreEscapedChildren(item.children, item.node);
  if (!copies.has(item.node)) return;
  const current = Array.from(item.node.childNodes);
  const tree = replacementTree(item.children, current);
  restoreNodeEdits(item);
  item.node.parentNode?.replaceChild(item.original, item.node);
  restoreChildren(item.original, current, item.children, tree);
  discardCopies(tree);
  copies.delete(item.node);
  mergedTexts.delete(item.node);
  forgetTextParent(item.node);
}

/** Recover transferred copies before collection can mistake them for source. */
export function restoreMovedRichNodes(roots: Iterable<Node>): void {
  const scopes = [...roots];
  // A merged page-owned survivor may precede its source host in document order,
  // or live in a container that has never been translated. Drain its document.
  const histories = new Set<TextHistory>();
  for (const scope of scopes) {
    const history = documentHistories.get(scope.ownerDocument ?? scope as Document);
    if (history) histories.add(history);
  }
  for (const history of histories) consumeTextRecords(history, history.observer.takeRecords());
  for (const scope of scopes) {
    const root = scope instanceof ShadowRoot ? scope : scope.getRootNode();
    if (!(root instanceof ShadowRoot)) continue;
    const history = documentHistories.get(root.ownerDocument);
    if (!history || [...history.roots].some((ref) => ref.deref() === root)) continue;
    recordUnobservedTexts(history, root);
    watchShadowRoot(history, root);
  }
  const visit = (node: Node): void => {
    if (node instanceof Element && node.matches(OURS_SEL)) return;
    const merged = mergedTexts.get(node);
    if (merged && node.parentNode) recoverTextRuns(node.parentNode, undefined, merged);
    const copy = copies.get(node);
    if (copy && node.isConnected) {
      // A page can reconnect a previously lost copy. Its node identity proves
      // ownership again; the earlier conservative decision must not persist.
      delete copy.saved.unresolvedValue;
      delete copy.saved.explicitReplacement;
    }
    if (copy?.run && node.parentNode && !textRuns.get(node.parentNode)?.includes(copy.run)) {
      recoverTextRuns(node.parentNode, copy.run);
    }
    if (copy && node.isConnected && !copy.host.contains(node)) {
      restoreCopy(copy.saved);
      return;
    }
    recoverTextRuns(node);
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  for (const root of scopes) {
    const parent = root.parentNode;
    if (parent instanceof Element && parent.closest(OURS_SEL)) continue;
    if (parent) recoverTextRuns(parent);
    visit(root);
  }
  for (const history of histories) preserveUnobservedSource(history);
}

/** Order a projected sibling list without moving unrelated source-only nodes. */
function orderSourceChildren(parent: Node, ordered: Node[]): void {
  const members = new Set(ordered);
  const current = Array.from(parent.childNodes).filter(node => members.has(node));
  if (current.length === ordered.length && current.every((node, i) => node === ordered[i])) return;
  let next = parent.firstChild;
  for (const node of ordered) {
    while (next && !members.has(next)) next = next.nextSibling;
    if (node === next) next = next.nextSibling;
    else parent.insertBefore(node, next);
  }
}

/**
 * Project flat copy order onto the actual source tree. Omitted wrappers are
 * anchors at their own level, so sorting their children cannot move surrounding
 * prose. Keep each wrapper around its first contiguous run; if the page
 * interleaves runs from different wrappers, later runs move to the enclosing
 * level rather than duplicating a wrapper or silently undoing the page order.
 */
function orderOriginals(parent: Node, ordered: RichReplacementNode[], saved: RichReplacementNode[]): void {
  const local = new Set(saved);
  const groups = new Map<Node, Node[]>();
  const placed = new Set<Node>();
  let open = new Set<Node>();
  const append = (container: Node, node: Node): void => {
    const children = groups.get(container);
    if (children) children.push(node);
    else groups.set(container, [node]);
  };
  for (const item of ordered) {
    const path: Node[] = [];
    if (local.has(item)) {
      // Preserve originals independently moved outside this source subtree.
      if (!parent.contains(item.original)) continue;
      for (let node = item.original.parentNode; node && node !== parent; node = node.parentNode) path.unshift(node);
    }
    let container = parent;
    const nextOpen = new Set<Node>();
    for (const wrapper of path) {
      if (placed.has(wrapper) && !open.has(wrapper)) break;
      if (!placed.has(wrapper)) { append(container, wrapper); placed.add(wrapper); }
      nextOpen.add(wrapper);
      container = wrapper;
    }
    append(container, item.original);
    open = nextOpen;
  }
  for (const [container, children] of groups) orderSourceChildren(container, children);
}

/** Reconcile page additions/removals and text edits into the hidden originals. */
function restoreChildren(parent: Node, current: Node[], saved: RichReplacementNode[], tree: ReplacementTree): void {
  const { byNode } = tree;
  const present = new Set(current);
  for (const item of saved) {
    if (item.unresolvedValue !== undefined) restoreNodeEdits(item, item.unresolvedValue);
    // The safe skeleton can unwrap source containers. Delete from the actual
    // source parent, preserving the wrapper and originals moved by page code.
    // A copy present elsewhere still owns its source and must not be deleted.
    if (!tree.present.has(item.node) && !item.node.isConnected
      && item.original.parentNode === item.originalParent && parent.contains(item.original)) {
      if (item.unresolvedValue === undefined) item.original.parentNode?.removeChild(item.original);
    }
  }

  const retained = saved.filter((item) => present.has(item.node));
  const ordered = current.flatMap((node) => byNode.has(node) ? [byNode.get(node)!] : []);
  if (ordered.some((item, i) => item !== retained[i])) {
    orderOriginals(parent, ordered, saved);
  }

  const anchors: (Node | null)[] = [];
  const following: (Node | null)[] = [];
  let next: Node | null = null;
  let nextOriginal: Node | null = null;
  for (let i = current.length - 1; i >= 0; i--) {
    anchors[i] = next;
    following[i] = nextOriginal;
    const original = byNode.get(current[i])?.original;
    if (original) {
      next = sourceChild(original, parent) ?? next;
      nextOriginal = original;
    }
  }
  let previousOriginal: Node | null = null;
  for (let i = 0; i < current.length; i++) {
    const node = current[i];
    const item = byNode.get(node);
    if (item) {
      previousOriginal = item.original;
      restoreNodeEdits(item);
      restoreChildren(item.original, Array.from(node.childNodes), item.children, tree);
      continue;
    }
    // New nodes belong to the page. Move them, preserving their identity and
    // position, but first restore any known clones moved inside a new wrapper.
    restoreChildren(node, Array.from(node.childNodes), [], tree);
    const nextSource = following[i];
    const sourceParent = previousOriginal?.parentNode;
    // Two retained siblings inside an unwrapped container still bracket an
    // insertion there. An outer anchor would move new middle text before both.
    if (sourceParent && sourceParent === nextSource?.parentNode && parent.contains(sourceParent)) {
      sourceParent.insertBefore(node, nextSource);
    } else parent.insertBefore(node, anchors[i]);
  }
}

export function restoreRichReplacement(
  host: HTMLElement,
  stash: Element,
  saved: RichReplacementNode[],
): void {
  recoverTextTree(host);
  restoreEscapedChildren(saved, host);
  restoreMovedRichNodes([host]);
  const current = Array.from(host.childNodes).filter((node) =>
    node !== stash && !(node instanceof Element && node.matches(OURS_SEL)),
  );
  const tree = replacementTree(saved, current);
  restoreChildren(stash, current, saved, tree);
  // Moved copies may no longer be top-level siblings of the stash.
  discardCopies(tree);
}
