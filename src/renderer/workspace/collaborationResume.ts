import type { CollaborationDocument, CollaborationSnapshot } from '../../shared/collaboration';

/** A restarted host has no acknowledgements for old requests; keep private text, not stale revisions. */
export function retainLocalDocuments(
  records: ReadonlyMap<string, { baseline: string; local: string; document?: CollaborationDocument }>,
) {
  return new Map(
    [...records].map(([path, record]) => [
      path,
      { baseline: record.document?.content ?? record.baseline, local: record.local },
    ]),
  );
}

/** A late restore never publishes a former tab set or applies data to a closed/replaced document. */
export class CollaborationResume {
  private revision = 0;
  invalidate() {
    this.revision++;
  }
  async run(options: {
    active(): boolean;
    snapshot(): Promise<CollaborationSnapshot>;
    adoptSnapshot(value: CollaborationSnapshot): boolean;
    documents(value: CollaborationSnapshot): string[];
    open(path: string): Promise<CollaborationDocument>;
    owns(path: string): boolean;
    adoptDocument(value: CollaborationDocument): void;
    publish(): void;
    failed(error: unknown): void;
  }) {
    const revision = ++this.revision;
    const current = () => revision === this.revision && options.active();
    try {
      const snapshot = await options.snapshot();
      if (!current()) return;
      if (!options.adoptSnapshot(snapshot)) {
        if (current()) options.publish();
        return;
      }
      for (const path of options.documents(snapshot)) {
        if (!current()) return;
        if (!options.owns(path)) continue;
        const document = await options.open(path);
        if (!current()) return;
        if (options.owns(path)) options.adoptDocument(document);
      }
      if (current()) options.publish();
    } catch (error) {
      if (current()) options.failed(error);
    }
  }
}
