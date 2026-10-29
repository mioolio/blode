/** Arduino Library Manager constraints: comparisons, !, &&, || and grouping. */
export interface ComponentDependency {
  name: string;
  constraint: string;
}

function versionParts(value: string) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new Error(`error.componentVersion: ${value}`);
  const numbers = match.slice(1, 4).map((part) => Number(part ?? 0));
  if (numbers.some((part) => !Number.isSafeInteger(part))) throw new Error('error.componentVersion');
  return { numbers, pre: match[4]?.split('.') };
}
export function compareComponentVersions(left: string, right: string): number {
  const a = versionParts(left),
    b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    return xn && yn ? Number(x) - Number(y) : xn ? -1 : yn ? 1 : x < y ? -1 : 1;
  }
  return 0;
}

export function componentVersionMatches(version: string, constraint = ''): boolean {
  versionParts(version);
  if (!constraint.trim()) return true;
  if (constraint.length > 512) throw new Error('error.componentDependency');
  const tokens = constraint.match(
    /\s*(>=|<=|!=|&&|\|\||[()!<>=]|\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*/g,
  );
  if (!tokens || tokens.join('').replace(/\s/g, '') !== constraint.replace(/\s/g, '') || tokens.length > 128)
    throw new Error(`error.componentDependency: ${constraint}`);
  const values = tokens.map((value) => value.trim());
  let cursor = 0;
  function primary(depth: number): boolean {
    if (depth > 16) throw new Error('error.componentDependency');
    if (values[cursor] === '!') {
      cursor++;
      return !primary(depth + 1);
    }
    if (values[cursor] === '(') {
      cursor++;
      const result = expression(depth + 1);
      if (values[cursor++] !== ')') throw new Error('error.componentDependency');
      return result;
    }
    const operator = ['>=', '<=', '!=', '>', '<', '='].includes(values[cursor]) ? values[cursor++] : '=';
    const target = values[cursor++];
    if (!target) throw new Error('error.componentDependency');
    const order = compareComponentVersions(version, target);
    return operator === '>='
      ? order >= 0
      : operator === '<='
        ? order <= 0
        : operator === '!='
          ? order !== 0
          : operator === '>'
            ? order > 0
            : operator === '<'
              ? order < 0
              : order === 0;
  }
  function conjunction(depth: number): boolean {
    let result = primary(depth);
    while (values[cursor] === '&&') {
      cursor++;
      const next = primary(depth);
      result = result && next;
    }
    return result;
  }
  function expression(depth: number): boolean {
    let result = conjunction(depth);
    while (values[cursor] === '||') {
      cursor++;
      const next = conjunction(depth);
      result = result || next;
    }
    return result;
  }
  const result = expression(0);
  if (cursor !== values.length) throw new Error('error.componentDependency');
  return result;
}

export function parseComponentDependencies(value: string): ComponentDependency[] {
  if (!value.trim()) return [];
  if (value.length > 8192) throw new Error('error.componentDependency');
  const entries = value.split(',').map((text) => {
    const match = /^([^()]+?)(?:\s*\((.*)\))?$/.exec(text.trim());
    if (!match || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(match[1].trim()))
      throw new Error(`error.componentDependency: ${text}`);
    const constraint = match[2]?.trim() ?? '';
    componentVersionMatches('0.0.0', constraint);
    return { name: match[1].trim(), constraint };
  });
  if (entries.length > 128) throw new Error('error.componentDependency');
  return entries;
}

export const dependencyLabel = (dependency: ComponentDependency) =>
  dependency.name + (dependency.constraint ? ` (${dependency.constraint})` : '');

export interface DependencyRelease {
  name: string;
  version: string;
  dependencies: ComponentDependency[];
}

/** Backtracking solves shared/transitive constraints without replacing project-owned versions. */
export function resolveComponentDependencies<T extends DependencyRelease>(
  catalog: Map<string, T[]>,
  required: ComponentDependency[],
  fixed: Map<string, string | undefined>,
  dependencies: (release: T) => ComponentDependency[] = (release) => release.dependencies,
): T[] {
  type Requirement = { name: string; constraints: string[] };
  let attempts = 0;
  const add = (map: Map<string, Requirement>, values: ComponentDependency[]) => {
    for (const value of values) {
      const key = value.name.toLowerCase();
      const existing = map.get(key);
      map.set(key, { name: value.name, constraints: [...(existing?.constraints ?? []), value.constraint] });
    }
    if (map.size > 128) throw new Error('error.componentTooLarge');
  };
  const solve = (requirements: Map<string, Requirement>, selected: Map<string, T>): Map<string, T> | null => {
    if (++attempts > 5000) throw new Error('error.componentDependency');
    let unresolved: [string, Requirement] | undefined;
    for (const [key, value] of requirements) {
      const version = selected.get(key)?.version ?? fixed.get(key);
      if (selected.has(key) || fixed.has(key)) {
        if (
          value.constraints.some(
            (constraint) => constraint && (!version || !componentVersionMatches(version, constraint)),
          )
        )
          return null;
      } else unresolved ??= [key, value];
    }
    if (!unresolved) return selected;
    const [key, requirement] = unresolved;
    for (const release of catalog.get(key) ?? []) {
      if (
        !requirement.constraints.every((constraint) => componentVersionMatches(release.version, constraint))
      )
        continue;
      const next = new Map(selected);
      next.set(key, release);
      const pending = new Map(requirements);
      add(pending, dependencies(release));
      const result = solve(pending, next);
      if (result) return result;
    }
    return null;
  };
  const initial = new Map<string, Requirement>();
  add(initial, required);
  const solution = solve(initial, new Map());
  if (!solution) throw new Error(`error.componentDependency: ${required.map(dependencyLabel).join(', ')}`);
  return [...solution.values()];
}
