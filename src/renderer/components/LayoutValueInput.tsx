import { useEffect, useState } from 'react';

/** Keep partial numeric input local; publish only complete aligned values. */
export function LayoutValueInput({
  value,
  min = 0,
  max = 0xffffffff,
  alignment = 1,
  hex = false,
  disabled,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  alignment?: number;
  hex?: boolean;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const format = (number: number) => (hex ? '0x' + number.toString(16).toUpperCase() : String(number));
  const [text, setText] = useState(() => format(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(format(value));
    setInvalid(false);
  }, [value, hex]);
  const commit = () => {
    const parsed = /^(?:0x[\da-f]+|\d+)$/i.test(text.trim()) ? Number(text.trim()) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max || parsed % alignment) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <input
      value={text}
      inputMode={hex ? 'text' : 'numeric'}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        setText(event.target.value);
        setInvalid(false);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setText(format(value));
          setInvalid(false);
        }
      }}
    />
  );
}
