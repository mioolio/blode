import { registerHooks } from 'node:module';

// Server-rendered component tests exercise markup; browser builds own style loading.
registerHooks({
  load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith('.css'))
      return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});
