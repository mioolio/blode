import type { InstallationProgress } from './contracts';

export function toolPhaseKey(
  phase: InstallationProgress['phase'],
  operation: InstallationProgress['operation'] = 'install',
): string {
  if (operation === 'export')
    return {
      starting: 'status.exportStarting',
      collecting: 'status.exportCollecting',
      packing: 'status.exportPacking',
      verifying: 'status.exportVerifying',
      completed: 'status.exportCompleted',
      failed: 'status.exportFailed',
      downloading: 'status.exportCollecting',
      extracting: 'status.exportCollecting',
      installing: 'status.exportPacking',
    }[phase];
  if (operation === 'download' && phase === 'starting') return 'status.downloadStarting';
  if (operation === 'download' && phase === 'completed') return 'status.downloadCompleted';
  if (operation === 'download' && phase === 'failed') return 'status.downloadFailed';
  return {
    starting: 'status.installStarting',
    collecting: 'status.exportCollecting',
    packing: 'status.exportPacking',
    downloading: 'status.installDownloading',
    verifying: 'status.installVerifying',
    extracting: 'status.installExtracting',
    installing: 'status.installInstalling',
    completed: 'status.installCompleted',
    failed: 'status.installFailed',
  }[phase];
}
