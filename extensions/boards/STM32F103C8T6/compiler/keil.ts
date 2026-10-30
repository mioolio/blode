import path from 'node:path';
import { DOMParser } from './vendor/xml.cjs';

export interface KeilInputs {
  name: string;
  device: string;
  files: string[];
  includes: string[];
  defines: string[];
  scatter?: string;
}
/** Read project metadata only: user build hooks and arbitrary compiler switches are never executed. */
export function parseKeilProject(xml: string, projectFile: string): KeilInputs {
  if (xml.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('error.keilProjectInvalid');
  let invalid = false;
  const doc = new DOMParser({
    errorHandler: {
      warning: () => {
        invalid = true;
      },
      error: () => {
        invalid = true;
      },
      fatalError: () => {
        invalid = true;
      },
    },
  }).parseFromString(xml, 'text/xml');
  const targets = Array.from(doc.getElementsByTagName('Target'));
  if (invalid || targets.length !== 1)
    throw new Error(targets.length > 1 ? 'error.keilTargetAmbiguous' : 'error.keilProjectInvalid');
  const target = targets[0];
  const text = (node: Element, tag: string) => node.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
  const resolve = (value: string) => {
    if (!value || /[$\0\r\n]/.test(value) || path.win32.isAbsolute(value))
      throw new Error('error.keilProjectPath');
    const result = path.posix.normalize(
      path.posix.join(path.posix.dirname(projectFile), value.replaceAll('\\', '/')),
    );
    if (result === '..' || result.startsWith('../') || result.startsWith('/'))
      throw new Error('error.keilProjectPath');
    return result;
  };
  const files: string[] = [];
  for (const group of Array.from(target.getElementsByTagName('Group'))) {
    const option = Array.from(group.childNodes).find((n) => n.nodeName === 'GroupOption') as
      Element | undefined;
    if (option && text(option, 'IncludeInBuild') === '0') continue;
    for (const file of Array.from(group.getElementsByTagName('File'))) {
      if (text(file, 'IncludeInBuild') === '0') continue;
      const value = text(file, 'FilePath');
      if (value) files.push(resolve(value));
    }
  }
  const cads = target.getElementsByTagName('Cads')[0];
  const defines = cads
    ? text(cads, 'Define')
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (defines.some((s) => !/^[A-Za-z_]\w*(?:=[^\r\n\0]+)?$/.test(s)))
    throw new Error('error.keilProjectInvalid');
  const includes = cads
    ? text(cads, 'IncludePath')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(resolve)
    : [];
  const ld = target.getElementsByTagName('LDads')[0];
  const scatter = ld ? text(ld, 'ScatterFile') : '';
  return {
    name: text(target, 'TargetName'),
    device: text(target, 'Device'),
    files: [...new Set(files)],
    includes,
    defines,
    ...(scatter ? { scatter: resolve(scatter) } : {}),
  };
}
