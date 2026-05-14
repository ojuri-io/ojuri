import { describe, it, expect } from 'vitest';
import { fmtNaira, fmtAge, ageTone, truncId } from '../src/components/shell.jsx';

describe('shell helpers', () => {
  it('fmtNaira prepends the naira sign and groups thousands', () => {
    expect(fmtNaira(0)).toBe('₦0');
    expect(fmtNaira(1_234)).toBe('₦1,234');
    expect(fmtNaira(1_250_000)).toBe('₦1,250,000');
  });

  it('fmtAge renders minutes / hours / days with the right grain', () => {
    expect(fmtAge(null)).toBe('—');
    expect(fmtAge(0)).toBe('0m');
    expect(fmtAge(59)).toBe('59m');
    expect(fmtAge(75)).toBe('1h 15m');
    expect(fmtAge(1500)).toBe('1d 1h');
  });

  it('ageTone escalates from sec → warn → danger by SLA buckets', () => {
    expect(ageTone(null)).toBe('');
    expect(ageTone(10)).toBe('sec');
    expect(ageTone(120)).toBe('warn');
    expect(ageTone(360)).toBe('danger');
  });

  it('truncId only shortens ids longer than the limit', () => {
    expect(truncId('abc')).toBe('abc');
    expect(truncId('abcdefghijkl', 8)).toBe('abcdefgh…');
  });
});
