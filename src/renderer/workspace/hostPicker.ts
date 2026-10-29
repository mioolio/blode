export interface HostPickerRequest {
  kind: 'directory' | 'file' | 'save';
  title?: string;
  defaultName?: string;
  extensions?: string[];
  resolve: (path: string | null) => void;
}
/** A server-side file picker; never opens the browser's client file chooser. */
export function pickHostPath(request: Omit<HostPickerRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) =>
    window.dispatchEvent(
      new CustomEvent<HostPickerRequest>('blode:host-picker', { detail: { ...request, resolve } }),
    ),
  );
}
