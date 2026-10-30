import type {
  ComponentLibrariesState,
  ComponentSearchResult,
  ComponentInstallRequest,
  ComponentImportRequest,
  ComponentRemoveRequest,
} from '../../shared/components';
import type { InstallationState, LogEvent } from '../../shared/contracts';

export interface ComponentLibrariesBackend {
  componentsState(): Promise<ComponentLibrariesState>;
  componentsSearch(query: string): Promise<ComponentSearchResult>;
  componentsInstall(request: ComponentInstallRequest): Promise<ComponentLibrariesState>;
  componentsImport(request: ComponentImportRequest): Promise<ComponentLibrariesState>;
  componentsRemove(request: ComponentRemoveRequest): Promise<ComponentLibrariesState>;
  componentsExport?(request: { expectedProjectRoot: string; ids?: string[]; confirm: true }): Promise<{
    id: string;
    name: string;
    size: number;
    sha256: string;
    componentCount: number;
    dependencies: string[];
  }>;
  componentsPackageSave?(id: string): Promise<boolean>;
}

export interface ComponentLibrariesSnapshot {
  data?: ComponentLibrariesState;
  query: string;
  search?: ComponentSearchResult;
  loading: boolean;
  searching: boolean;
  operation: 'install' | 'import' | 'remove' | 'export' | null;
  installation?: InstallationState;
  error: string;
  completed: boolean;
}

/** Keeps project writes and async searches attached to the dialog that started them. */
export class ComponentLibrariesModel {
  private value: ComponentLibrariesSnapshot = {
    query: '',
    loading: false,
    searching: false,
    operation: null,
    error: '',
    completed: false,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private searchSequence = 0;
  private listSequence = 0;
  private live = true;
  private installationId?: string;

  constructor(
    private api: ComponentLibrariesBackend,
    readonly projectRoot: string,
  ) {}

  get active() {
    return this.live;
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  activate() {
    this.live = true;
    this.generation++;
  }
  dispose() {
    this.live = false;
    this.generation++;
  }
  private current(generation: number) {
    return this.live && generation === this.generation;
  }
  private update(change: Partial<ComponentLibrariesSnapshot>) {
    if (!this.live) return;
    this.value = { ...this.value, ...change };
    this.listeners.forEach((listener) => listener());
  }
  private fail(error: unknown) {
    this.update({ error: error instanceof Error ? error.message : String(error), completed: false });
  }

  async load() {
    if (!this.projectRoot || !this.live || this.value.operation) return;
    const generation = this.generation,
      sequence = ++this.listSequence;
    this.update({ loading: true, error: '' });
    try {
      const data = await this.api.componentsState();
      if (!this.current(generation) || sequence !== this.listSequence) return;
      if (data.projectRoot !== this.projectRoot) throw new Error('components.projectChanged');
      this.update({ data });
    } catch (error) {
      if (this.current(generation) && sequence === this.listSequence) this.fail(error);
    } finally {
      if (this.current(generation) && sequence === this.listSequence) this.update({ loading: false });
    }
  }

  setQuery(query: string) {
    this.searchSequence++;
    this.update({ query, search: undefined, searching: false, error: '', completed: false });
  }

  async search() {
    const query = this.value.query.trim();
    if (!query || !this.live) return;
    const generation = this.generation,
      sequence = ++this.searchSequence;
    this.update({ searching: true, error: '', completed: false });
    try {
      const result = await this.api.componentsSearch(query);
      if (this.current(generation) && sequence === this.searchSequence) this.update({ search: result });
    } catch (error) {
      if (this.current(generation) && sequence === this.searchSequence) this.fail(error);
    } finally {
      if (this.current(generation) && sequence === this.searchSequence) this.update({ searching: false });
    }
  }

  receive(event: LogEvent) {
    const progress = event.installation;
    if (!this.live || !progress) return;
    if (
      this.value.operation &&
      !this.installationId &&
      progress.tool === 'components' &&
      progress.phase === 'starting'
    )
      this.installationId = progress.id;
    if (progress.id !== this.installationId) return;
    const current = this.value.installation;
    this.update({
      installation: {
        ...progress,
        logs: event.progressOnly
          ? current?.id === progress.id
            ? current.logs
            : []
          : [...(current?.id === progress.id ? current.logs.slice(-299) : []), event],
      },
    });
  }

  private async mutate(
    operation: NonNullable<ComponentLibrariesSnapshot['operation']>,
    run: (expectedProjectRoot: string) => Promise<ComponentLibrariesState>,
  ): Promise<boolean> {
    if (!this.live || this.value.operation) return false;
    const generation = this.generation;
    const expectedProjectRoot = this.value.data?.projectRoot;
    if (!expectedProjectRoot || expectedProjectRoot !== this.projectRoot) {
      this.fail(new Error(this.projectRoot ? 'components.projectChanged' : 'components.noProject'));
      return false;
    }
    this.listSequence++;
    this.installationId = undefined;
    this.update({ operation, installation: undefined, error: '', completed: false, loading: false });
    try {
      const data = await run(expectedProjectRoot);
      if (!this.current(generation)) return false;
      if (data.projectRoot !== this.projectRoot) throw new Error('components.projectChanged');
      this.update({ data, completed: true });
      return true;
    } catch (error) {
      if (this.current(generation)) this.fail(error);
      return false;
    } finally {
      if (this.current(generation)) this.update({ operation: null });
    }
  }

  install(name: string, version: string) {
    return this.mutate('install', (expectedProjectRoot) =>
      this.api.componentsInstall({ name, version, expectedProjectRoot, confirm: true }),
    );
  }
  import(path: string, kind: 'directory' | 'archive') {
    return this.mutate('import', (expectedProjectRoot) =>
      this.api.componentsImport({ path, kind, expectedProjectRoot, confirm: true }),
    );
  }
  remove(id: string) {
    return this.mutate('remove', (expectedProjectRoot) =>
      this.api.componentsRemove({ id, expectedProjectRoot, confirm: true }),
    );
  }
  async export(ids?: string[]): Promise<boolean> {
    if (!this.live || this.value.operation) return false;
    const expectedProjectRoot = this.value.data?.projectRoot;
    if (!expectedProjectRoot || expectedProjectRoot !== this.projectRoot) {
      this.fail(new Error('components.projectChanged'));
      return false;
    }
    const generation = this.generation;
    this.update({ operation: 'export', error: '', completed: false });
    try {
      if (!this.api.componentsExport || !this.api.componentsPackageSave)
        throw new Error('rpc.methodNotFound');
      const archive = await this.api.componentsExport({
        expectedProjectRoot,
        ...(ids?.length ? { ids } : {}),
        confirm: true,
      });
      if (!this.current(generation)) return false;
      const saved = await this.api.componentsPackageSave(archive.id);
      if (!this.current(generation)) return false;
      this.update({ completed: saved });
      return saved;
    } catch (error) {
      if (this.current(generation)) this.fail(error);
      return false;
    } finally {
      if (this.current(generation)) this.update({ operation: null });
    }
  }
}
