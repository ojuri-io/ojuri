import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Stub the API client before importing the page so the page receives our
// mock instead of hitting `safe(() => fetch(...))`. The mock returns a
// realistic shape so the Stat header and table both render.
const mockCatalog = {
  schemaVersion: 'v1',
  baseVersion: 'v1',
  inputDimension: 3,
  adopterSha256: null,
  features: [
    {
      index: 0,
      name: 'velocity_1h',
      category: 'velocity',
      source: 'paa:redis',
      dtype: 'float',
      default: 0,
      description: 'Per-sender 1h velocity.',
      compute: null,
    },
    {
      index: 1,
      name: 'amount',
      category: 'transaction',
      source: 'rda:request',
      dtype: 'float',
      default: 0,
      description: 'Transaction amount.',
      compute: null,
    },
    {
      index: 2,
      name: 'custom_ratio',
      category: 'adopter',
      source: 'rda:derived',
      dtype: 'float',
      default: 0,
      description: 'Adopter ratio.',
      compute: { type: 'ratio', numerator: { field: 'a' }, denominator: { field: 'b' } },
    },
  ],
};

vi.mock('../src/api/client.js', () => ({
  getFeatureCatalog: vi.fn(() => Promise.resolve(mockCatalog)),
}));

import Features from '../src/pages/features.jsx';

describe('Features page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders schema header + every catalogue row', async () => {
    render(<Features toast={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('velocity_1h')).toBeInTheDocument();
    });

    expect(screen.getByText('Schema version')).toBeInTheDocument();
    expect(screen.getByText('Input dimension')).toBeInTheDocument();
    expect(screen.getByText('amount')).toBeInTheDocument();
    expect(screen.getByText('custom_ratio')).toBeInTheDocument();
  });

  it('tags adopter-overlay features with an overlay pill', async () => {
    render(<Features toast={() => {}} />);
    await waitFor(() => expect(screen.getByText('custom_ratio')).toBeInTheDocument());
    // The pill only renders on rows whose `compute` is non-null.
    expect(screen.getByText('overlay')).toBeInTheDocument();
  });

  it('filters by search query against name and description', async () => {
    render(<Features toast={() => {}} />);
    await waitFor(() => expect(screen.getByText('velocity_1h')).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/search by name/i);
    fireEvent.change(search, { target: { value: 'velocity' } });

    expect(screen.getByText('velocity_1h')).toBeInTheDocument();
    expect(screen.queryByText('amount')).not.toBeInTheDocument();
    expect(screen.queryByText('custom_ratio')).not.toBeInTheDocument();
  });

  it('shows an unreachable banner when the catalogue endpoint returns null', async () => {
    const { getFeatureCatalog } = await import('../src/api/client.js');
    getFeatureCatalog.mockResolvedValueOnce(null);

    render(<Features toast={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/rda unreachable/i)).toBeInTheDocument();
    });
  });
});
