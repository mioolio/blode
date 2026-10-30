const sharedMethods = new Set(['getState', 'listPorts', 'listDebugProbes', 'windowAction', 'hostBrowse']);

/** Secondary windows use their scoped debugger API, never unrestricted project writes. */
export function isDebuggerWindowMethod(method: unknown): boolean {
  return (
    typeof method === 'string' &&
    (sharedMethods.has(method) || method.startsWith('runtimePlugin') || method.startsWith('debugger'))
  );
}
