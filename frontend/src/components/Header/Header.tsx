import React, { useEffect, useRef, useState } from 'react';

interface HeaderProps {
  onSearch: (query: string) => void;
  /**
   * The query the URL is asking for. Seeds the box and is adopted again
   * whenever it changes to something the box is not already showing — a
   * shared `?q=` link, a reload, the back key.
   *
   * Deliberately a seed rather than the value itself: every keystroke already
   * goes out through `onQueryChange`, and having the parent own the text and
   * send it back would cost a render per character for what the box already
   * has. Adoption is keyed on this prop
   * *changing*, never on it merely differing, because a difference is the
   * normal state mid-word — the URL only catches up once the typing debounce
   * settles, and re-imposing it before then would delete what is being typed.
   */
  initialQuery?: string;
  /**
   * Every keystroke, so the board can narrow locally while a word is still
   * being typed. Optional: the box works exactly as before without it, and
   * nothing here debounces — the hook owns that timing.
   */
  onQueryChange?: (query: string) => void;
  onClear?: () => void;
  /** A live query is in flight. Only the submit button waits for it. */
  searching?: boolean;
}

const Header: React.FC<HeaderProps> = ({
  onSearch,
  onQueryChange,
  onClear,
  initialQuery = '',
  searching = false,
}) => {
  const [value, setValue] = useState(initialQuery);
  const adopted = useRef(initialQuery);

  useEffect(() => {
    if (adopted.current === initialQuery) return;
    adopted.current = initialQuery;
    // The URL stores the query trimmed, so what comes back is an echo of the
    // box rather than a new instruction whenever the two differ only by
    // whitespace. Replacing the value there would delete the space a visitor
    // just typed between two words and jump the caret to the end.
    setValue((current) => (current.trim() === initialQuery ? current : initialQuery));
  }, [initialQuery]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Adopting what we are about to publish keeps the effect above from
    // reading the URL's echo of this word as a new link to restore.
    adopted.current = e.target.value;
    setValue(e.target.value);
    onQueryChange?.(e.target.value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    adopted.current = value.trim();
    onSearch(value.trim());
  };

  const handleClear = () => {
    adopted.current = '';
    setValue('');
    onClear?.();
  };

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-paper/85 backdrop-blur-sm">
      <div className="mx-auto max-w-2xl px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-ink">今日菜價</h1>
          <span className="text-xs text-stone">台灣蔬果批發行情</span>
        </div>

        <form onSubmit={handleSubmit} className="mt-3 flex items-center gap-3 border-b border-line focus-within:border-ink transition-colors">
          <input
            type="search"
            inputMode="search"
            value={value}
            onChange={handleChange}
            placeholder="搜尋蔬果（例如：高麗菜、番茄）"
            className="min-w-0 flex-1 bg-transparent py-2 text-base text-ink placeholder:text-stone outline-none"
          />
          {value && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="清除搜尋"
              className="text-stone hover:text-ink text-lg leading-none"
            >
              ×
            </button>
          )}
          <button
            type="submit"
            disabled={searching}
            className="shrink-0 text-sm text-sage hover:text-ink disabled:opacity-50 transition-colors"
          >
            {searching ? '查詢中' : '搜尋'}
          </button>
        </form>
      </div>
    </header>
  );
};

export default Header;
