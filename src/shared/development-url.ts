/** Development renderers stay on the launcher's loopback HTTP server. */
export function developmentRendererUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error('error.invalidDevServer');
  }
}
