import type { SourceLocation } from '../../shared/language';

export type NavigationPane = 'primary' | 'secondary';
interface Snapshot {
  root: string;
  primary: string;
  secondary: string;
  active: boolean;
}
/** File loads and back stacks belong to their originating pane. */
export class SourceNavigation {
  private sequence = { primary: 0, secondary: 0 };
  private history: Record<NavigationPane, SourceLocation[]> = { primary: [], secondary: [] };
  constructor(
    private readonly options: {
      snapshot(): Snapshot;
      exists(path: string): boolean;
      external(id: string): Promise<{ path: string }>;
      open(pane: NavigationPane, path: string): void;
      locate(pane: NavigationPane, target: SourceLocation): void;
      failed(error: unknown): void;
    },
  ) {}
  reset() {
    this.sequence.primary++;
    this.sequence.secondary++;
    this.history = { primary: [], secondary: [] };
  }
  async visit(
    root: string,
    target: SourceLocation,
    origin?: SourceLocation,
    pane: NavigationPane = 'primary',
  ): Promise<boolean> {
    const before = this.options.snapshot();
    if (before.root !== root || !before.active || (pane === 'secondary' && !before.secondary)) return false;
    const sequence = ++this.sequence[pane];
    const current = () => {
      const now = this.options.snapshot();
      return (
        this.sequence[pane] === sequence && now.root === root && now.active && now[pane] === before[pane]
      );
    };
    try {
      const external = !!target.externalId;
      if (target.externalId)
        target = { ...target, path: (await this.options.external(target.externalId)).path };
      if (!current() || (!external && !this.options.exists(target.path))) return false;
      if (origin) {
        this.history[pane].push(origin);
        if (this.history[pane].length > 100) this.history[pane].shift();
      }
      this.options.open(pane, target.path);
      this.options.locate(pane, { ...target });
      return true;
    } catch (error) {
      if (current()) this.options.failed(error);
      return false;
    }
  }
  back(pane: NavigationPane = 'primary') {
    const target = this.history[pane].pop();
    return target
      ? this.visit(this.options.snapshot().root, target, undefined, pane)
      : Promise.resolve(false);
  }
}
