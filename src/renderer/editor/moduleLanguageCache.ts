import { withModuleLanguageOverrides, type ModuleLanguageState } from '../../shared/module-languages';
import type { CStandard, LanguageRuleFile } from '../../../extensions/completions/rules';

/** Typing source code must not reparse or stringify an unchanged language catalog. */
export class ModuleLanguageCache {
  private input: ModuleLanguageState | undefined;
  private inputSignature = '';
  private standard: CStandard | undefined;
  private assets: readonly LanguageRuleFile[] = [];
  private result: { state: ModuleLanguageState | undefined; signature: string } | undefined;
  constructor(private readonly resolve = withModuleLanguageOverrides) {}
  update(input: ModuleLanguageState | undefined, files: readonly LanguageRuleFile[], standard: CStandard) {
    const inputSignature =
      input === this.input && this.result ? this.inputSignature : JSON.stringify(input ?? null);
    const assets = input?.entries.some((entry) => entry.id === 'c')
      ? files.filter(
          (file) =>
            file.path === 'blode.completions.json' ||
            (file.path.startsWith(`languages/C/${standard}/`) && file.path.endsWith('.json')),
        )
      : [];
    const changed =
      !this.result ||
      this.inputSignature !== inputSignature ||
      this.standard !== standard ||
      this.assets.length !== assets.length ||
      this.assets.some(
        (asset, index) => asset.path !== assets[index].path || asset.content !== assets[index].content,
      );
    this.input = input;
    this.inputSignature = inputSignature;
    if (changed) {
      this.standard = standard;
      this.assets = assets;
      const state = input && this.resolve(input, assets, standard);
      this.result = { state, signature: JSON.stringify(state ?? null) };
    }
    return this.result!;
  }
}
