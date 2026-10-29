import {
  analyzeCSourceRules,
  resolveCCompletionPack,
  type CCompletionPack,
  type CStandard,
  type LanguageRuleDiagnostic,
  type LanguageRuleFile,
} from '../../../extensions/completions/rules';

/** Rule JSON and source buffers have separate invalidation domains. */
export class LanguageRuleCache {
  private files = new Map<string, LanguageRuleFile>();
  private assets: LanguageRuleFile[] = [];
  private standard: CStandard = 'c17';
  private useBuiltins = true;
  private project = '';
  private mixedCpp = false;
  private packCache: CCompletionPack | undefined;
  private sourceCache = new Map<string, { content: string; diagnostics: LanguageRuleDiagnostic[] }>();
  constructor(private readonly analyze = analyzeCSourceRules) {}

  update(
    files: readonly LanguageRuleFile[],
    standard: CStandard,
    useBuiltins: boolean,
    project: string,
  ): void {
    const assets = files.filter(
      (file) =>
        file.path === 'blode.completions.json' ||
        (file.path.startsWith(`languages/C/${standard}/`) && file.path.endsWith('.json')),
    );
    const changed =
      this.project !== project ||
      this.standard !== standard ||
      this.useBuiltins !== useBuiltins ||
      assets.length !== this.assets.length ||
      assets.some(
        (file, index) => file.path !== this.assets[index].path || file.content !== this.assets[index].content,
      );
    const mixedCpp = files.some((file) => /\.(?:cpp|cxx|cc|ino|hpp|hxx)$/i.test(file.path));
    if (changed) this.packCache = undefined;
    if (changed || mixedCpp !== this.mixedCpp) this.sourceCache.clear();
    this.files = new Map(files.map((file) => [file.path, file]));
    this.assets = assets;
    this.standard = standard;
    this.useBuiltins = useBuiltins;
    this.project = project;
    this.mixedCpp = mixedCpp;
    for (const path of this.sourceCache.keys()) if (!this.files.has(path)) this.sourceCache.delete(path);
  }

  pack(): CCompletionPack {
    return (this.packCache ??= resolveCCompletionPack(this.assets, this.standard, {
      useBuiltins: this.useBuiltins,
    }));
  }

  /** Called only for models that exist in this window, not every workspace file. */
  diagnostics(path: string): LanguageRuleDiagnostic[] {
    const pack = this.pack();
    const configured = pack.diagnostics.filter((item) => item.file === path);
    const file = this.files.get(path);
    if (!file || (!/\.c$/i.test(path) && (!/\.h$/i.test(path) || this.mixedCpp))) return configured;
    const cached = this.sourceCache.get(path);
    if (cached?.content === file.content)
      return configured.length ? [...configured, ...cached.diagnostics] : cached.diagnostics;
    const diagnostics = this.analyze([file], this.standard, { pack, mixedCpp: this.mixedCpp });
    this.sourceCache.set(path, { content: file.content, diagnostics });
    return configured.length ? [...configured, ...diagnostics] : diagnostics;
  }
}
