// electron-builder's older dependencies call require('minimatch') directly.
// Keep that API while delegating all pattern processing to the patched engine.
const engine = require('minimatch-engine');
class Minimatch extends engine.Minimatch {
  constructor(...args) {
    super(...args);
    // glob 7 consumes parsed path segments via String.match and `_glob`.
    // minimatch 11's non-RegExp matcher still owns all matching/limits.
    for (const parts of this.set)
      for (const part of parts) {
        if (part && typeof part === 'object' && typeof part.test === 'function') {
          part._glob = part.pattern;
          part[Symbol.match] = (text) => (part.test(text) ? [text] : null);
        }
      }
  }
}
module.exports = Object.assign((...args) => engine.minimatch(...args), engine, { Minimatch });
