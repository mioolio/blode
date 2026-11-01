import { useEffect, useState } from 'react';

/** Panel visibility belongs to the workbench, independent of the open project. */
export function usePanelVisibility(key: string, startHidden = false) {
  const [visible, setVisible] = useState(() => {
    if (startHidden) return false;
    try {
      return localStorage.getItem(key) !== 'hidden';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, visible ? 'visible' : 'hidden');
    } catch {
      // Layout remains usable when browser storage is unavailable.
    }
  }, [key, visible]);
  return [visible, setVisible] as const;
}
