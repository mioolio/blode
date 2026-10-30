/** This policy belongs to a separate plugin document, never the main workbench. */
export const RUNTIME_VIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; child-src 'none'; object-src 'none'";

const bridge = `(function(){let sequence=0;const pending=new Map();window.addEventListener('message',function(event){if(event.source!==parent||event.data?.channel!=='blode-runtime-ui')return;const request=pending.get(event.data.id);if(!request)return;pending.delete(event.data.id);clearTimeout(request.timer);event.data.error?request.reject(new Error(event.data.error)):request.resolve(event.data.result);});function request(method,args=[]){return new Promise(function(resolve,reject){const id='runtime-ui-'+(++sequence);const timer=setTimeout(function(){pending.delete(id);reject(new Error('Runtime UI request timed out'));},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({channel:'blode-runtime-ui',id,method,args},'*');});}window.blodeRuntime=Object.freeze({request,openView:(id)=>request('view.open',[id]),context:()=>request('context.get'),configure:(value)=>request('config.update',[value]),device:(method,args=[],confirm)=>request('device.invoke',[method,args,confirm])});})();`;

export function renderRuntimeView(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${RUNTIME_VIEW_CSP}"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${bridge}</script></head><body>${html}</body></html>`;
}
