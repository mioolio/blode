import path from 'node:path';
import type { RuntimeViewContribution } from '../../shared/plugins';
import { RUNTIME_VIEW_CSP } from '../../shared/runtime-view';
import type { ExtensionPackage } from './package';
import { extensionRelative } from './schema';

const bridge = `(function(){let sequence=0;const pending=new Map();window.addEventListener('message',event=>{if(event.source!==parent||event.data?.channel!=='blode-extension-ui')return;const request=pending.get(event.data.id);if(!request)return;pending.delete(event.data.id);clearTimeout(request.timer);event.data.error?request.reject(new Error(event.data.error)):request.resolve(event.data.result);});function request(method,args=[]){return new Promise((resolve,reject)=>{const id='extension-ui-'+(++sequence),timer=setTimeout(()=>{pending.delete(id);reject(Error('Request timed out'));},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({channel:'blode-extension-ui',id,method,args},'*');});}window.blodeExtension=Object.freeze({context:()=>request('context.get'),configure:values=>request('settings.update',[values]),openView:id=>request('view.open',[id])});})();`;
/** Reuse the runtime frame policy; external resources and network requests remain disabled. */
export function renderExtensionDocument(pack: ExtensionPackage, view: RuntimeViewContribution): string {
  const resolve = (reference: string) => {
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(view.file), reference));
    if (!extensionRelative.safeParse(relative).success || !pack.files.has(relative))
      throw new Error('error.extensionPath');
    return relative;
  };
  let html = pack.files.get(view.file)!.toString('utf8');
  if (html.length > 1_000_000) throw new Error('error.extensionSize');
  html = html.replace(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi, (_tag, reference: string) => {
    const file = resolve(reference);
    if (!/\.css$/i.test(file)) throw new Error('error.extensionPath');
    return (
      '<style>' +
      pack.files
        .get(file)!
        .toString('utf8')
        .replace(/<\/style/gi, '<\\/style') +
      '</style>'
    );
  });
  html = html.replace(
    /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    (_tag, before: string, reference: string, after: string) => {
      const file = resolve(reference);
      if (!/\.(?:mjs|js)$/i.test(file)) throw new Error('error.extensionPath');
      return (
        `<script${before}${after}>` +
        pack.files
          .get(file)!
          .toString('utf8')
          .replace(/<\/script/gi, '<\\/script') +
        '</script>'
      );
    },
  );
  html = html.replace(/(<img\b[^>]*\bsrc=)["']([^"']+)["']/gi, (_tag, prefix: string, reference: string) => {
    const file = resolve(reference),
      type = (
        {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
        } as Record<string, string>
      )[path.extname(file)];
    if (!type) throw new Error('error.extensionPath');
    return `${prefix}"data:${type};base64,${pack.files.get(file)!.toString('base64')}"`;
  });
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${RUNTIME_VIEW_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${bridge}</script></head><body>${html}</body></html>`;
}
