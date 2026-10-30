import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useI18n } from '../i18n';
import { filterSelectOptions, selectNavigation, type SelectOption } from './modernSelectModel';
import './modern-select.css';

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'>;
const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((part) =>
      typeof part === 'string' || typeof part === 'number'
        ? String(part)
        : isValidElement<{ children?: ReactNode }>(part)
          ? textOf(part.props.children)
          : '',
    )
    .join('');
export function selectOptions(children: ReactNode, group?: string, groupDisabled = false): SelectOption[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{ value?: string | number; label?: string; disabled?: boolean; children?: ReactNode }>(
        child,
      )
    )
      return [];
    if (child.type === 'optgroup')
      return selectOptions(child.props.children, child.props.label, groupDisabled || child.props.disabled);
    if (child.type !== 'option') return selectOptions(child.props.children, group, groupDisabled);
    const label = child.props.label ?? textOf(child.props.children);
    return [
      {
        value: String(child.props.value ?? label),
        label,
        group,
        disabled: groupDisabled || child.props.disabled,
      },
    ];
  });
}

/** Searchable single-value selector. The native form control preserves form and fieldset semantics. */
export function ModernSelect({
  children,
  onChange,
  value,
  defaultValue,
  disabled,
  className,
  style,
  ...props
}: Props) {
  const { t } = useI18n();
  const id = useId();
  const listId = `select-list-${id}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [internal, setInternal] = useState(String(defaultValue ?? ''));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  }>({ top: 0, left: 0, width: 240, maxHeight: 320 });
  const options = selectOptions(children);
  const selectedValue = String(value ?? internal);
  const chosen = options.find((option) => option.value === selectedValue);
  const filtered = filterSelectOptions(options, query);
  const searchable = options.length > 7 || !!query;
  const isDisabled = () => !!disabled || !!native.current?.matches(':disabled');
  const measure = () => {
    if (!trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const room = window.innerHeight - rect.bottom - 12;
    const above = room < 180 && rect.top > room;
    const height = Math.max(96, Math.min(340, above ? rect.top - 12 : room));
    const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 16);
    setPosition({
      top: above ? undefined : rect.bottom + 5,
      bottom: above ? window.innerHeight - rect.top + 5 : undefined,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      maxHeight: height,
    });
  };
  const close = (focus = false) => {
    setOpen(false);
    setQuery('');
    if (focus) trigger.current?.focus();
  };
  const show = (key?: string) => {
    if (isDisabled()) return;
    measure();
    setQuery('');
    const selected = options.findIndex((option) => option.value === selectedValue && !option.disabled);
    setActive(
      key === 'End'
        ? selectNavigation(options, -1, 'End')
        : selected >= 0
          ? selected
          : selectNavigation(options, -1, 'Home'),
    );
    setOpen(true);
  };
  const choose = (option: SelectOption) => {
    if (option.disabled || isDisabled() || !native.current) return;
    setInternal(option.value);
    native.current.value = option.value;
    onChange?.({ target: native.current, currentTarget: native.current } as ChangeEvent<HTMLSelectElement>);
    close(true);
  };
  const navigate = (event: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) show(event.key);
      else setActive(selectNavigation(filtered, active, event.key));
    } else if (event.key === 'Enter' || (event.key === ' ' && event.target === trigger.current)) {
      event.preventDefault();
      if (!open) show();
      else if (filtered[active]) choose(filtered[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab' && open) {
      event.preventDefault();
      const boundary = trigger.current?.closest('dialog, [role="dialog"]') ?? document;
      const controls = [
        ...boundary.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'),
      ].filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          element.getClientRects().length > 0 &&
          !popup.current?.contains(element),
      );
      const index = controls.indexOf(trigger.current!);
      close();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    } else if (!open && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      show();
      setQuery(event.key);
    } else if (
      open &&
      event.target !== input.current &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      setQuery((value) => value + event.key);
    }
  };
  useEffect(() => {
    if (!open) return;
    if (searchable) input.current?.focus();
    else popup.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node))
        close();
    };
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) measure();
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open, searchable]);
  useEffect(() => {
    if (open) setActive(selectNavigation(filtered, -1, 'Home'));
  }, [query]);
  useEffect(() => {
    if (open && active >= 0)
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  useEffect(() => {
    if (open && isDisabled()) close();
  });
  return (
    <span className={`modern-select ${className ?? ''}`} style={style}>
      <button
        type="button"
        ref={trigger}
        className="modern-select-trigger"
        role="combobox"
        aria-label={props['aria-label'] ?? chosen?.label}
        aria-labelledby={props['aria-labelledby']}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={navigate}
      >
        <span>{chosen?.label ?? selectedValue ?? '—'}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <select
        {...props}
        className="modern-select-native"
        ref={native}
        tabIndex={-1}
        aria-hidden="true"
        value={selectedValue}
        disabled={disabled}
        onChange={(event) => {
          setInternal(event.target.value);
          onChange?.(event);
        }}
      >
        {children}
      </select>
      {open &&
        createPortal(
          <div
            className="modern-select-popup"
            ref={popup}
            tabIndex={-1}
            style={position}
            onKeyDown={navigate}
          >
            {searchable && (
              <label className="modern-select-search">
                <Search size={14} />
                <input
                  ref={input}
                  value={query}
                  aria-label={t('select.search')}
                  placeholder={t('select.search')}
                  aria-controls={listId}
                  aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            )}
            <div
              id={listId}
              className="modern-select-options"
              role="listbox"
              aria-label={props['aria-label'] ?? chosen?.label}
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            >
              {filtered.map((option, index) => (
                <div key={`${option.value}-${index}`}>
                  {option.group && option.group !== filtered[index - 1]?.group && (
                    <div className="modern-select-group">{option.group}</div>
                  )}
                  <button
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={selectedValue === option.value}
                    disabled={option.disabled}
                    className={active === index ? 'is-active' : ''}
                    onPointerMove={() => !option.disabled && setActive(index)}
                    onClick={() => choose(option)}
                  >
                    <span>{option.label}</span>
                    {selectedValue === option.value && <Check size={14} aria-hidden="true" />}
                  </button>
                </div>
              ))}
              {!filtered.length && (
                <p className="modern-select-empty" role="status">
                  {t('select.empty')}
                </p>
              )}
            </div>
          </div>,
          // Native modal dialogs make body siblings inert regardless of z-index.
          // Keep the popup in its trigger's top-layer dialog so pointer/focus routing agrees.
          trigger.current?.closest('dialog') ?? document.body,
        )}
    </span>
  );
}
