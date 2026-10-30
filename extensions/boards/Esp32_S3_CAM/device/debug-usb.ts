import type { RuntimeHost } from '../../../runtime.js';

interface UsbDevice {
  id: string;
  parent: string | null;
  service: string | null;
  present: boolean | null;
  problem: number | null;
}
interface Options {
  runner: RuntimeHost['runCommand'];
  platform?: NodeJS.Platform;
  serialNumber?: string;
  signal?: AbortSignal;
  onDiagnostic?: (message: string) => void;
}
const native = /^USB\\VID_303A&PID_1001(?:&[^\\]+)?\\[^\\]+$/i;
const jtag = /^USB\\VID_303A&PID_1001&MI_02\\[^\\]+$/i;
const composite = /^USB\\VID_303A&PID_1001\\[^\\]+$/i;
// Read-only. No user-controlled values are interpolated into PowerShell.
const enumeration = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$canReadParent = $null -ne (Get-Command Get-PnpDeviceProperty -ErrorAction SilentlyContinue)
$devices = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB%'" | ForEach-Object {
  $parent = $null
  if ($canReadParent -and $_.PNPDeviceID -match '^USB\\VID_303A&PID_1001&MI_02\\') {
    try { $parent = (Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName 'DEVPKEY_Device_Parent' -ErrorAction Stop).Data } catch {}
  }
  [pscustomobject]@{ id = $_.PNPDeviceID; parent = $parent; service = $_.Service; present = $_.Present; problem = $_.ConfigManagerErrorCode }
})
[pscustomobject]@{ complete = $true; devices = $devices } | ConvertTo-Json -Depth 4 -Compress
`;

function parseDevices(output: string): UsbDevice[] {
  if (output.length > 1_000_000) throw new Error('USB enumeration output is too large');
  const value = JSON.parse(output.replace(/^\uFEFF/, '').trim());
  if (value?.complete !== true || !Array.isArray(value.devices) || value.devices.length > 4096)
    throw new Error('Incomplete USB enumeration');
  for (const device of value.devices) {
    if (
      !device ||
      typeof device.id !== 'string' ||
      !device.id ||
      device.id.length > 4096 ||
      !(device.parent === null || typeof device.parent === 'string') ||
      !(device.service === null || typeof device.service === 'string') ||
      !(device.present === null || typeof device.present === 'boolean') ||
      !(
        device.problem === null ||
        (Number.isInteger(device.problem) && device.problem >= 0 && device.problem <= 255)
      )
    )
      throw new Error('Invalid USB enumeration record');
  }
  return value.devices;
}
function serial(id: string): string | undefined {
  if (!composite.test(id)) return undefined;
  const value = id.slice(id.lastIndexOf('\\') + 1);
  // Windows location-generated instance suffixes are not the USB iSerialNumber.
  return /^[a-z0-9:_-]{1,128}$/i.test(value) ? value : undefined;
}
function serialKey(value: string): string {
  const compact = value.replace(/[:-]/g, '');
  return /^[a-f0-9]{12}$/i.test(compact) ? compact.toLowerCase() : value.toLowerCase();
}

/** Windows USB-JTAG preflight runs once per explicit connection. Other hosts use OpenOCD diagnostics. */
export async function preflightEsp32UsbJtag(options: Options): Promise<void> {
  if (options.signal?.aborted) throw new Error('error.operationCancelled');
  if ((options.platform ?? process.platform) !== 'win32') return;
  let devices: UsbDevice[];
  try {
    const result = await options.runner(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(enumeration, 'utf16le').toString('base64'),
      ],
      { timeout: 12_000, signal: options.signal },
    );
    if (result.code !== 0) throw new Error(result.stderr || result.output || `Exit ${result.code}`);
    devices = parseDevices(result.stdout ?? result.output);
  } catch (error) {
    if (options.signal?.aborted) throw new Error('error.operationCancelled');
    options.onDiagnostic?.(`USB-JTAG preflight unavailable: ${String(error).slice(0, 2048)}`);
    return;
  }
  if (options.signal?.aborted) throw new Error('error.operationCancelled');
  const candidates = devices.filter(
    (device) => native.test(device.id) && device.present !== false && device.problem !== 45,
  );
  if (!candidates.length) {
    const bridges = [
      ...new Set(
        devices
          .filter((device) => device.present !== false && device.problem !== 45)
          .map((device) =>
            /^USB\\(VID_(?:1A86|10C4|0403)&PID_[A-F0-9]{4})(?:&[^\\]+)?\\/i
              .exec(device.id)?.[1]
              ?.toUpperCase(),
          )
          .filter((value): value is string => !!value),
      ),
    ].slice(0, 8);
    options.onDiagnostic?.(
      `USB-JTAG: native VID_303A&PID_1001 not found.${bridges.length ? ` USB-UART bridges: ${bridges.join(', ')}.` : ''}`,
    );
    throw new Error('error.debuggerUsbJtagMissing');
  }
  // Present=null is not proof of attachment. Let OpenOCD decide on older/incomplete CIM providers.
  if (candidates.some((device) => device.present === null)) {
    options.onDiagnostic?.('USB-JTAG preflight: device presence could not be confirmed.');
    return;
  }
  const groups = new Map<string, { id: string; parent?: UsbDevice; interfaces: UsbDevice[] }>();
  for (const device of candidates.filter((device) => composite.test(device.id)))
    groups.set(device.id.toLowerCase(), { id: device.id, parent: device, interfaces: [] });
  const parents = [...groups.values()];
  const interfaces = candidates.filter((device) => jtag.test(device.id));
  for (const device of interfaces) {
    const parent = device.parent && composite.test(device.parent) ? device.parent : undefined;
    const inferred = !parent && parents.length === 1 && interfaces.length === 1 ? parents[0].id : undefined;
    const id = parent ?? inferred ?? device.id;
    const group = groups.get(id.toLowerCase()) ?? { id, interfaces: [] };
    group.interfaces.push(device);
    groups.set(id.toLowerCase(), group);
  }
  // Only a native serial interface was exposed, or an unusual driver owns the whole USB device.
  if (!groups.size) {
    options.onDiagnostic?.(
      'USB-JTAG preflight: native USB device found; JTAG interface details are unavailable.',
    );
    return;
  }
  const values = [...groups.values()];
  let selected = values;
  const requested = options.serialNumber ?? '';
  if (requested) {
    selected = values.filter((group) => {
      const value = serial(group.id);
      return value && serialKey(value) === serialKey(requested);
    });
    if (!selected.length) {
      if (values.every((group) => serial(group.id))) {
        options.onDiagnostic?.(
          `USB-JTAG: requested USB serial does not match ${values.length} native device(s).`,
        );
        throw new Error('error.debuggerUsbJtagSerialMismatch');
      }
      options.onDiagnostic?.('USB-JTAG preflight: USB serial numbers could not be confirmed.');
      return;
    }
  } else if (values.length > 1) {
    options.onDiagnostic?.(
      `USB-JTAG: ${values.length} native device(s) detected; select a USB serial number.`,
    );
    throw new Error('error.debuggerUsbJtagAmbiguous');
  }
  if (selected.length > 1) {
    options.onDiagnostic?.(`USB-JTAG: ${selected.length} native devices match the requested USB serial.`);
    throw new Error('error.debuggerUsbJtagAmbiguous');
  }
  const group = selected[0];
  const records = group.interfaces.length ? group.interfaces : group.parent ? [group.parent] : [];
  for (const device of records) {
    options.onDiagnostic?.(
      `USB-JTAG: ${device.id}; driver=${device.service || '(unknown)'}; problem=${device.problem ?? '(unknown)'}`,
    );
    if (device.problem !== null && device.problem !== 0) throw new Error('error.debuggerUsbJtagDriver');
    // libusbK/libusb0 can be valid too; unknown services are diagnosed by OpenOCD, not rejected here.
  }
}
