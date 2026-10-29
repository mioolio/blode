import type { LanguageSource, LanguageSymbol, LanguageInclude, LanguageIndexSnapshot } from './language';

interface Token {
  text: string;
  start: number;
  end: number;
}
interface Parsed {
  symbols: LanguageSymbol[];
  includes: LanguageInclude[];
}
const sourceExtension = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|ipp|ino)$/i;
const controls = new Set([
  'if',
  'for',
  'while',
  'switch',
  'return',
  'sizeof',
  'alignof',
  '_Alignof',
  'typeof',
  'catch',
  'throw',
  'case',
  'else',
  'do',
  'delete',
  'new',
  'static_assert',
  '_Static_assert',
]);
const modifiers = new Set([
  'static',
  'extern',
  'inline',
  'const',
  'volatile',
  'unsigned',
  'signed',
  'long',
  'short',
  'register',
  'auto',
  'constexpr',
  'consteval',
  'virtual',
  'friend',
  'explicit',
  'typedef',
  'struct',
  'enum',
  'union',
  'class',
]);
const identifier = /^[A-Za-z_]\w*$/;
export const normalizeSourcePath = (value: string) => value.replaceAll('\\', '/').replace(/^\.\//, '');

function relativePath(value: string): string {
  const parts: string[] = [];
  for (const part of normalizeSourcePath(value).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return '';
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

/** Comment and string masking preserves UTF-16 offsets, including CRLF files. */
function maskTrivia(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
    (value) => value.replace(/[^\r\n]/g, ' '),
  );
}

function parse(file: LanguageSource): Parsed {
  const symbols: LanguageSymbol[] = [],
    includes: LanguageInclude[] = [];
  const symbolOffsets = new Set<number>();
  const lines = [0];
  for (let i = 0; i < file.content.length; i++) if (file.content[i] === '\n') lines.push(i + 1);
  const position = (offset: number) => {
    let low = 0,
      high = lines.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (lines[mid] <= offset) low = mid;
      else high = mid;
    }
    return { line: low + 1, column: offset - lines[low] + 1 };
  };
  const location = (start: number, end: number) => {
    const a = position(start),
      b = position(end);
    return { path: normalizeSourcePath(file.path), ...a, endLine: b.line, endColumn: b.column };
  };
  const add = (
    token: Token,
    kind: LanguageSymbol['kind'],
    signature: string,
    definition: boolean,
    local = false,
  ) => {
    if (symbols.length >= 50000) return;
    if (symbolOffsets.has(token.start)) return;
    symbolOffsets.add(token.start);
    symbols.push({
      ...location(token.start, token.end),
      name: token.text,
      kind,
      signature: signature.replace(/\s+/g, ' ').trim().slice(0, 400),
      definition,
      ...(local ? { local: true } : {}),
    });
  };
  const masked = maskTrivia(file.content);
  for (const match of file.content.matchAll(/^\s*#\s*include\s*["<]([^">\r\n]+)[">]/gm)) {
    const hash = file.content.indexOf('#', match.index);
    if (masked[hash] !== '#') continue;
    const start = match.index! + match[0].indexOf(match[1]);
    includes.push({
      ...location(start, start + match[1].length),
      specifier: match[1],
      system: match[0].includes('<'),
    });
  }
  for (const match of masked.matchAll(/^\s*#\s*define[ \t]+([A-Za-z_]\w*)/gm)) {
    const start = match.index! + match[0].lastIndexOf(match[1]);
    const end = file.content.indexOf('\n', start);
    add(
      { text: match[1], start, end: start + match[1].length },
      'macro',
      file.content.slice(file.content.indexOf('#', match.index), end < 0 ? undefined : end),
      true,
    );
  }
  const code = masked.replace(/^[ \t]*#(?:[^\r\n]*\\\r?\n)*[^\r\n]*/gm, (value) =>
    value.replace(/[^\r\n]/g, ' '),
  );
  const tokens: Token[] = [];
  for (const m of code.matchAll(/[A-Za-z_]\w*|::|->|&&|\.\.\.|[^\s]/g)) {
    if (tokens.length >= 400000) break;
    tokens.push({ text: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  const paired = new Map<number, number>(),
    stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (['(', '[', '{'].includes(tokens[i].text)) stack.push(i);
    else if ([')', ']', '}'].includes(tokens[i].text)) {
      const expected = { ')': '(', ']': '[', '}': '{' }[tokens[i].text];
      if (stack.length && tokens[stack.at(-1)!].text === expected) {
        const open = stack.pop()!;
        paired.set(open, i);
        paired.set(i, open);
      }
    }
  }
  const functionBodies: { start: number; end: number }[] = [];
  const boundary = (i: number) => {
    while (i >= 0 && ![';', '{', '}'].includes(tokens[i].text)) i--;
    return i + 1;
  };
  for (let i = 0; i < tokens.length - 1; i++) {
    const name = tokens[i];
    if (!identifier.test(name.text) || controls.has(name.text) || tokens[i + 1].text !== '(') continue;
    const close = paired.get(i + 1);
    if (close === undefined) continue;
    let after = close + 1;
    while (
      after < tokens.length &&
      ['const', 'noexcept', 'override', 'final', '&', '&&'].includes(tokens[after].text)
    )
      after++;
    if (!tokens[after] || ![';', '{'].includes(tokens[after].text)) continue;
    const start = boundary(i - 1),
      prefix = tokens.slice(start, i);
    if (
      !prefix.length ||
      prefix.some((token) => ['=', '.', '->', 'return', '(', ')', ','].includes(token.text))
    )
      continue;
    if (!prefix.some((token) => identifier.test(token.text) && !controls.has(token.text))) continue;
    const definition = tokens[after].text === '{';
    add(name, 'function', file.content.slice(tokens[start].start, tokens[close].end), definition);
    if (definition)
      functionBodies.push({ start: tokens[after].start, end: tokens[paired.get(after) ?? after].end });
  }
  const localAt = (offset: number) => functionBodies.some((body) => offset > body.start && offset < body.end);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      ['struct', 'enum', 'union', 'class'].includes(token.text) &&
      identifier.test(tokens[i + 1]?.text ?? '')
    ) {
      const name = tokens[i + 1],
        next = tokens[i + 2]?.text;
      if (['{', ';', ':'].includes(next))
        add(name, 'type', `${token.text} ${name.text}`, next !== ';', localAt(name.start));
      if (token.text === 'enum') {
        let open = i + 2;
        while (tokens[open] && !['{', ';'].includes(tokens[open].text)) open++;
        const end = paired.get(open);
        if (end) {
          for (let n = open + 1; n < end; n++)
            if (identifier.test(tokens[n].text) && ['{', ','].includes(tokens[n - 1].text))
              add(tokens[n], 'constant', `${name.text}::${tokens[n].text}`, true);
        }
      }
    }
    if (token.text === 'typedef') {
      let end = i + 1;
      while (tokens[end] && tokens[end].text !== ';') {
        if (tokens[end].text === '{' && paired.has(end)) end = paired.get(end)!;
        end++;
      }
      const segment = tokens.slice(i + 1, end);
      const pointer = segment.findIndex(
        (item, index) =>
          item.text === '*' &&
          segment[index - 1]?.text === '(' &&
          identifier.test(segment[index + 1]?.text ?? ''),
      );
      const name =
        pointer >= 0
          ? segment[pointer + 1]
          : [...segment].reverse().find((item) => identifier.test(item.text));
      if (name)
        add(
          name,
          'type',
          file.content.slice(token.start, tokens[end]?.end ?? name.end),
          true,
          localAt(name.start),
        );
    }
    if (!identifier.test(token.text) || controls.has(token.text) || modifiers.has(token.text)) continue;
    if (![';', '=', '[', ','].includes(tokens[i + 1]?.text ?? '')) continue;
    const start = boundary(i - 1),
      prefix = tokens.slice(start, i);
    if (
      !prefix.length ||
      prefix.some((item) => ['(', ')', '=', '.', '->', 'return', 'typedef'].includes(item.text))
    )
      continue;
    const type = prefix.find((item) => identifier.test(item.text) && !modifiers.has(item.text));
    if (!type || controls.has(type.text)) continue;
    add(
      token,
      'variable',
      file.content.slice(tokens[start].start, token.end),
      !prefix.some((item) => item.text === 'extern'),
      localAt(token.start),
    );
  }
  return { symbols, includes };
}

/** A file is reparsed only when its text changes; current buffers override disk. */
export class WorkspaceLanguageIndex {
  private files = new Map<string, { content: string; parsed: Parsed }>();
  update(sources: readonly LanguageSource[]): number {
    const live = new Set<string>();
    let changed = 0;
    for (const source of sources) {
      const path = normalizeSourcePath(source.path);
      if (!sourceExtension.test(path)) continue;
      live.add(path);
      if (this.files.get(path)?.content === source.content) continue;
      this.files.set(path, { content: source.content, parsed: parse({ ...source, path }) });
      changed++;
    }
    for (const path of this.files.keys())
      if (!live.has(path)) {
        this.files.delete(path);
        changed++;
      }
    return changed;
  }
  snapshot(projectRoot = ''): LanguageIndexSnapshot {
    return {
      version: 1,
      projectRoot,
      fileCount: this.files.size,
      symbols: [...this.files.values()].flatMap((file) => file.parsed.symbols),
      includes: [...this.files.values()].flatMap((file) => file.parsed.includes),
    };
  }
  definitions(name: string, from: string, declaration = false): LanguageSymbol[] {
    const symbols = this.snapshot().symbols.filter(
      (symbol) => symbol.name === name && (!symbol.local || symbol.path === from),
    );
    const preferred = symbols.filter((symbol) => (declaration ? !symbol.definition : symbol.definition));
    return (preferred.length ? preferred : symbols).sort(
      (a, b) =>
        Number(b.path === from) - Number(a.path === from) || a.path.localeCompare(b.path) || a.line - b.line,
    );
  }
  resolveInclude(from: string, specifier: string): string[] {
    const directory = normalizeSourcePath(from).split('/').slice(0, -1).join('/');
    const relative = relativePath(`${directory}/${specifier}`),
      root = relativePath(specifier);
    if (this.files.has(relative)) return [relative];
    if (this.files.has(root)) return [root];
    return [...this.files.keys()].filter((file) => file.endsWith(`/${root}`) || file === root).sort();
  }
  source(path: string): string | undefined {
    return this.files.get(normalizeSourcePath(path))?.content;
  }
}
