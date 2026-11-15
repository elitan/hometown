type Option<T> = { v: T; label: string };

export function Segmented<T extends string | number>({ options, value, onChange }: { options: Option<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(o => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={o.v === value}
          className={o.v === value ? 'on' : ''}
          onClick={() => o.v !== value && onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
