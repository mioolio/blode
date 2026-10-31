import type { DevicePackageInfo } from '../../shared/device-packages';

export function deviceModulePage(
  packages: DevicePackageInfo[],
  query: string,
  requestedPage: number,
  pageSize = 25,
) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = words.length
    ? packages.filter((item) => {
        const text = `${item.name} ${item.id} ${item.version} ${item.support.join(' ')}`.toLocaleLowerCase();
        return words.every((word) => text.includes(word));
      })
    : packages;
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.max(0, Math.min(pages - 1, requestedPage));
  return {
    entries: matches.slice(page * pageSize, (page + 1) * pageSize),
    total: matches.length,
    pages,
    page,
  };
}
