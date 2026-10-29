import type { DriverDefinition } from '../../drivers/types.js';

/**
 * STSW-LINK009, the signed WinUSB/VCP driver package for ST-Link/V2 and newer probes.
 * The INF files and USB IDs below come from that official package; keep them in sync
 * when a new STSW-LINK release is bundled.
 */
export const stlinkDriver: DriverDefinition = Object.freeze({
  id: 'stlink',
  name: 'ST-Link',
  archive: 'stsw-link009.zip',
  infFiles: ['stlink_dbg_winusb.inf', 'stlink_bridge_winusb.inf', 'stlink_VCP.inf'],
  deviceIds: [
    'VID_0483&PID_3748',
    'VID_0483&PID_374A',
    'VID_0483&PID_374B',
    'VID_0483&PID_374D',
    'VID_0483&PID_374E',
    'VID_0483&PID_374F',
    'VID_0483&PID_3752',
    'VID_0483&PID_3753',
    'VID_0483&PID_3754',
    'VID_0483&PID_3755',
    'VID_0483&PID_3757',
  ],
  storeEntry: /^stlink_(?:dbg|bridge|vcp)_winusb\.inf_/i,
});
