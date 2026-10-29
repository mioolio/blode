export type MiValue = string | MiValue[] | { [key: string]: MiValue };
/** Bounded recursive reader for GDB/MI tuples, lists and C strings. */
export function parseMiValues(source: string): Record<string, MiValue> {
  if (source.length > 1_000_000) throw new Error('error.debuggerProtocol');
  let p = 0;
  const key = () => {
    const start = p;
    while (p < source.length && /[\w.-]/.test(source[p])) p++;
    return source.slice(start, p);
  };
  const value = (depth: number): MiValue => {
    if (depth > 24) throw new Error('error.debuggerProtocol');
    if (source[p] === '"') {
      p++;
      let result = '';
      while (p < source.length) {
        let c = source[p++];
        if (c === '"') return result;
        if (c === '\\') {
          c = source[p++];
          result += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : (c ?? '');
        } else result += c;
      }
      throw new Error('error.debuggerProtocol');
    }
    if (source[p] === '{' || source[p] === '[') {
      const array = source[p++] === '[';
      const end = array ? ']' : '}';
      const list: MiValue[] = [];
      const object: Record<string, MiValue> = {};
      while (p < source.length && source[p] !== end) {
        const start = p;
        const name = key();
        if (source[p] === '=') {
          p++;
          const item = value(depth + 1);
          if (array) list.push({ [name]: item });
          else object[name] = item;
        } else {
          p = start;
          list.push(value(depth + 1));
        }
        if (source[p] === ',') p++;
        else if (source[p] !== end) throw new Error('error.debuggerProtocol');
      }
      if (source[p++] !== end) throw new Error('error.debuggerProtocol');
      return array ? list : object;
    }
    const start = p;
    while (p < source.length && !/[,\]}]/.test(source[p])) p++;
    if (start === p) throw new Error('error.debuggerProtocol');
    return source.slice(start, p);
  };
  const result: Record<string, MiValue> = {};
  while (p < source.length) {
    if (source[p] === ',') {
      p++;
      continue;
    }
    const name = key();
    if (!name || source[p++] !== '=') throw new Error('error.debuggerProtocol');
    result[name] = value(0);
  }
  return result;
}
