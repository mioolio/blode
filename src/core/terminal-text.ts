import { stripVTControlCharacters } from 'node:util';

/** Node's ANSI matcher leaves the final X from ConPTY's CSI erase-character command. */
export function terminalText(data: string) {
  return stripVTControlCharacters(data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
}

/** A column-one cursor jump is a new output row in the compatibility transcript. */
export function terminalLines(data: string) {
  return terminalText(data.replace(/\x1b\[\d+;1[Hf]/g, '\n')).split('\n');
}
