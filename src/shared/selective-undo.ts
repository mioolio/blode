import type { CollaborationChange } from './collaboration';

export interface UndoEvent {
  revision: number;
  changes: CollaborationChange[];
}
export interface UndoGroup {
  author: string;
  revision: number;
  changes: CollaborationChange[];
  at: number;
  active: boolean;
  events: number[];
  undoEvents: number[];
  expected: string[];
  redo?: { revision: number; changes: CollaborationChange[]; expected: string[] };
}

export function inverseChanges(before: string, changes: CollaborationChange[]): CollaborationChange[] {
  let delta = 0;
  return changes.map((change) => {
    const inverse = {
      start: change.start + delta,
      end: change.start + delta + change.text.length,
      text: before.slice(change.start, change.end),
    };
    delta += change.text.length - (change.end - change.start);
    return inverse;
  });
}

export function recordUndo(
  groups: UndoGroup[],
  before: string,
  changes: CollaborationChange[],
  revision: number,
  author: string,
  at: number,
) {
  // A new action only clears this author's redo, leaving other users' independent history usable.
  for (const group of groups) if (!group.active && group.author === author) group.redo = undefined;
  const previous = groups.at(-1),
    edit = changes.length === 1 ? changes[0] : undefined;
  const prior = previous?.changes.length === 1 ? previous.changes[0] : undefined;
  if (
    previous?.active &&
    previous.author === author &&
    previous.revision === revision - 1 &&
    at - previous.at <= 800 &&
    edit &&
    prior &&
    edit.start <= prior.end &&
    edit.end >= prior.start
  ) {
    const start = Math.min(edit.start, prior.start),
      end = Math.max(edit.end, prior.end);
    const text = before.slice(start, prior.start) + prior.text + before.slice(prior.end, end);
    previous.changes = [{ start, end: end + edit.text.length - (edit.end - edit.start), text }];
    const after = before.slice(0, edit.start) + edit.text + before.slice(edit.end);
    previous.expected = [after.slice(start, previous.changes[0].end)];
    previous.events.push(revision);
    previous.revision = revision;
    previous.at = at;
  } else
    groups.push({
      author,
      revision,
      changes: inverseChanges(before, changes),
      expected: changes.map((change) => change.text),
      events: [revision],
      undoEvents: [],
      at,
      active: true,
    });
  while (
    groups.length > 256 ||
    (groups.length > 1 &&
      groups.reduce(
        (sum, item) =>
          sum +
          item.changes.reduce((n, change) => n + change.text.length, 0) +
          (item.redo?.changes.reduce((n, change) => n + change.text.length, 0) ?? 0),
        0,
      ) > 2_000_000)
  )
    groups.shift();
}

/** Keep undo edits off ranges another author has replaced or extended internally. */
export function transformUndo(
  changes: CollaborationChange[],
  applied: CollaborationChange[],
): CollaborationChange[] | null {
  return changes
    .map((change) => ({ ...change }))
    .reduce<CollaborationChange[] | null>((result, next) => {
      if (!result) return null;
      let left = 0,
        right = 0;
      const insertion = next.start === next.end;
      for (const prior of applied) {
        const priorInsertion = prior.start === prior.end;
        if (
          insertion
            ? prior.start < next.start && next.start < prior.end
            : priorInsertion
              ? next.start < prior.start && prior.start < next.end
              : next.start < prior.end && prior.start < next.end
        )
          return null;
        const delta = prior.text.length - (prior.end - prior.start);
        if (prior.end <= next.start) left += delta;
        if (prior.end < next.end || (prior.end === next.end && (!priorInsertion || insertion)))
          right += delta;
      }
      result.push({ start: next.start + left, end: next.end + (insertion ? left : right), text: next.text });
      return result;
    }, []);
}

export function planUndo(
  groups: UndoGroup[],
  history: UndoEvent[],
  author: string,
  direction: 'undo' | 'redo',
  global = false,
  current?: string,
): { group: UndoGroup; changes: CollaborationChange[] } | 'overlap' | 'historyExpired' | null {
  const eligible = groups.filter(
    (group) =>
      (global || group.author === author) &&
      (direction === 'undo' ? group.active : !group.active && !!group.redo),
  );
  const group =
    direction === 'undo'
      ? eligible.sort((a, b) => a.revision - b.revision).at(-1)
      : eligible.sort((a, b) => a.redo!.revision - b.redo!.revision).at(-1);
  if (!group) return null;
  const source =
    direction === 'undo'
      ? { revision: group.revision, changes: group.changes, expected: group.expected }
      : group.redo!;
  if (history.length && source.revision < history[0].revision - 1) return 'historyExpired';
  let changes: CollaborationChange[] | null = structuredClone(source.changes);
  for (const event of history)
    if (event.revision > source.revision) {
      const transformed = transformUndo(changes, event.changes);
      if (transformed) changes = transformed;
      else {
        // Only traverse a group's changes if its state is unchanged since this inverse's base.
        // Retain both kinds of event: undo B, undo A, redo A, redo B must work even when A/B overlap.
        // A new active remote replacement still conflicts, including one with coincidentally equal text.
        if (
          !groups.some((item) => {
            if (!item.events.includes(event.revision) && !item.undoEvents.includes(event.revision))
              return false;
            const activeAtBase =
              Math.max(-1, ...item.events.filter((revision) => revision <= source.revision)) >
              Math.max(-1, ...item.undoEvents.filter((revision) => revision <= source.revision));
            return activeAtBase === item.active;
          })
        )
          return 'overlap';
        const map = (offset: number, end: boolean) => {
          let delta = 0;
          for (const prior of event.changes) {
            if (prior.end < offset || (prior.end === offset && (prior.start !== prior.end || !end)))
              delta += prior.text.length - (prior.end - prior.start);
            else if (prior.start < offset && offset < prior.end)
              return prior.start + delta + Math.min(offset - prior.start, prior.text.length);
          }
          return offset + delta;
        };
        changes = changes.map((change) => ({
          ...change,
          start: map(change.start, false),
          end: map(change.end, true),
        }));
      }
    }
  if (
    current !== undefined &&
    changes.some((change, index) => current.slice(change.start, change.end) !== source.expected[index])
  )
    return 'overlap';
  return { group, changes };
}

/** Own-only fallback for a browser editing with shared synchronization disabled. */
export class LocalUndoHistory {
  private revision = 0;
  private events: UndoEvent[] = [];
  private groups: UndoGroup[] = [];
  record(before: string, changes: CollaborationChange[], own: boolean) {
    this.revision++;
    this.events.push({ revision: this.revision, changes: structuredClone(changes) });
    if (own) recordUndo(this.groups, before, changes, this.revision, 'self', Date.now());
    while (this.events.length > 512) this.events.shift();
  }
  take(before: string, direction: 'undo' | 'redo'): CollaborationChange[] | null {
    const plan = planUndo(this.groups, this.events, 'self', direction, false, before);
    if (typeof plan === 'string') throw new Error('collaboration.undoConflict');
    if (!plan) return null;
    const inverse = inverseChanges(before, plan.changes);
    this.record(before, plan.changes, false);
    let after = before;
    for (const change of [...plan.changes].reverse())
      after = after.slice(0, change.start) + change.text + after.slice(change.end);
    const expected = inverse.map((change) => after.slice(change.start, change.end));
    if (direction === 'undo') {
      plan.group.active = false;
      plan.group.undoEvents.push(this.revision);
      plan.group.undoEvents = plan.group.undoEvents.slice(-512);
      plan.group.redo = { revision: this.revision, changes: inverse, expected };
    } else {
      plan.group.active = true;
      plan.group.revision = this.revision;
      plan.group.changes = inverse;
      plan.group.expected = expected;
      plan.group.events.push(this.revision);
      plan.group.events = plan.group.events.slice(-512);
      plan.group.redo = undefined;
      plan.group.at = 0;
    }
    return plan.changes;
  }
}
