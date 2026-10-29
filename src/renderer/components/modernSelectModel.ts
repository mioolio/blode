export interface SelectOption {
  value: string;
  label: string;
  group?: string;
  disabled?: boolean;
}

export function filterSelectOptions(options: SelectOption[], query: string): SelectOption[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((option) =>
    terms.every((term) =>
      `${option.label} ${option.value} ${option.group ?? ''}`.toLocaleLowerCase().includes(term),
    ),
  );
}

export function selectNavigation(options: SelectOption[], current: number, key: string): number {
  const enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1)!;
  const found = enabled.indexOf(current);
  return key === 'ArrowUp'
    ? enabled[found < 0 ? enabled.length - 1 : (found + enabled.length - 1) % enabled.length]
    : enabled[(found + 1) % enabled.length];
}
