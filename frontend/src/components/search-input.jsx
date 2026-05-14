// Search/text inputs that defer commit until Enter or blur-after-edit.
//
// Why: typing should not fire a refetch on every keystroke. The parent
// owns the committed query and re-queries; the input owns the in-flight
// draft. This avoids the storm of API calls users were seeing when they
// typed into the transactions / audit / users / etc. search boxes.
//
// How to apply: replace `<input value={search} onChange={…setSearch}/>`
// with `<SearchInput value={search} onCommit={setSearch}/>`. The parent's
// `search` state is what filters/fetches; the input's local draft is only
// surfaced on Enter or on blur if the draft differs from `value`.

import React, { useState, useEffect, useRef } from 'react';
import { Ti } from './shell.jsx';

/**
 * Committed-on-Enter text input. The parent never sees mid-typing values.
 *
 * Why: search-on-keyup was firing too many API calls. Local draft +
 * commit-on-Enter (or blur-after-dirty) gives users a stable contract:
 * "I'll search when you tell me to."
 *
 * How to apply: pass the parent's committed `value` in and an `onCommit`
 * callback. The input keeps a draft that resets when `value` changes
 * (e.g. parent clears the filter). Clearing via the × button commits
 * the empty string immediately so users get the obvious "reset" UX.
 */
export function SearchInput({
  value,
  onCommit,
  placeholder,
  hint = 'Press Enter to search',
  showIcon = true,
  showHint = true,
  inputRef,
  style,
  className,
  ...rest
}) {
  const [draft, setDraft] = useState(value || '');

  // Re-sync the draft when the parent's value changes from outside
  // (e.g. a "Reset filters" button). We use a ref so we don't fight
  // the user's in-progress typing.
  const lastSeen = useRef(value);
  useEffect(() => {
    if (value !== lastSeen.current) {
      setDraft(value || '');
      lastSeen.current = value;
    }
  }, [value]);

  const commit = (next) => {
    lastSeen.current = next;
    if (next !== value) onCommit(next);
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 200, ...style }} className={className}>
      {showIcon && (
        <Ti
          name="search"
          size={14}
          style={{
            position: 'absolute',
            left: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--color-text-tertiary)',
          }}
        />
      )}
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Escape') {
            // Revert to last committed value on Escape.
            setDraft(value || '');
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          if (draft !== value) commit(draft);
        }}
        placeholder={placeholder}
        title={hint}
        style={{
          width: '100%',
          paddingLeft: showIcon ? 32 : 10,
          paddingRight: draft ? 28 : 10,
        }}
        {...rest}
      />
      {draft && (
        <button
          type="button"
          onClick={() => {
            setDraft('');
            commit('');
          }}
          aria-label="Clear search"
          title="Clear"
          style={{
            position: 'absolute',
            right: 4,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            padding: 4,
            cursor: 'pointer',
            color: 'var(--color-text-tertiary)',
            lineHeight: 0,
          }}
        >
          <Ti name="x" size={12} />
        </button>
      )}
      {showHint && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: draft ? 28 : 8,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 9,
            color: 'var(--color-text-quaternary)',
            pointerEvents: 'none',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            opacity: draft && draft !== value ? 1 : 0.55,
          }}
          title={hint}
        >
          {draft && draft !== value ? '↵' : ''}
        </span>
      )}
    </div>
  );
}

/**
 * Date-range panel that commits both bounds together on Enter or Apply.
 *
 * Why: editing a `datetime-local` input fires onChange on every digit,
 * which would refetch on each keystroke. We capture local draft state
 * and only call `onApply` when the user is done editing.
 *
 * How to apply: keep the parent's committed `from` / `to` in state.
 * Render `<DateRangeFilter from={…} to={…} onApply={…}/>` and (optionally)
 * also `<DateRangeApplyBar … />` rendered through a `children`-style render
 * prop, so the Apply button shares the same draft. To keep components
 * simple we expose the panel itself with an internal Apply button when
 * `inline` is true.
 */
export function DateRangeFilter({
  from,
  to,
  onApply,
  onReset,
  inline = true,
  hint = 'Press Enter or click Apply',
}) {
  const [draftFrom, setDraftFrom] = useState(from || '');
  const [draftTo, setDraftTo] = useState(to || '');
  const dirty = draftFrom !== (from || '') || draftTo !== (to || '');

  useEffect(() => {
    setDraftFrom(from || '');
  }, [from]);
  useEffect(() => {
    setDraftTo(to || '');
  }, [to]);

  const commit = () => {
    if (!dirty) return;
    onApply({ from: draftFrom, to: draftTo });
  };

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          <p className="label-up" style={{ margin: '0 0 4px' }}>FROM</p>
          <input
            type="datetime-local"
            className="mono"
            value={draftFrom}
            onChange={(e) => setDraftFrom(e.target.value)}
            onKeyDown={onKey}
            title={hint}
            style={{ width: '100%', fontSize: 12 }}
          />
        </div>
        <div>
          <p className="label-up" style={{ margin: '0 0 4px' }}>TO</p>
          <input
            type="datetime-local"
            className="mono"
            value={draftTo}
            onChange={(e) => setDraftTo(e.target.value)}
            onKeyDown={onKey}
            title={hint}
            style={{ width: '100%', fontSize: 12 }}
          />
        </div>
      </div>
      {inline && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
            {hint}. Leaving both empty disables the range.
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            {onReset && (
              <button
                onClick={() => {
                  setDraftFrom('');
                  setDraftTo('');
                  onReset();
                }}
              >
                Reset
              </button>
            )}
            <button className="info-bg" disabled={!dirty} onClick={commit}>
              Apply
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default SearchInput;
