import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import Upload from '../Upload';

const globalFetch = vi.fn();
vi.stubGlobal('fetch', globalFetch);

function mockFetchSequence(responses: any[]) {
  globalFetch.mockReset();
  for (const r of responses) {
    globalFetch.mockResolvedValueOnce({ ok: true, json: async () => r } as Response);
  }
}

describe('Upload', () => {
  it('posts file and polls status', async () => {
    mockFetchSequence([{ id: 1 }, { status: 'ocr' }, { status: 'ocr_done' }, { pages: [{ width: 100, height: 100, blocks: [] }] }]);
    render(
      <MemoryRouter>
        <Upload />
      </MemoryRouter>
    );
    const file = new File(['a'], 'a.pdf', { type: 'application/pdf' });
    const input = screen.getByTestId('drop-input') as HTMLInputElement;
    await userEvent.upload(input, file);
    await waitFor(() => expect(globalFetch).toHaveBeenCalledWith(expect.stringContaining('/upload'), expect.anything()));
    await waitFor(() => expect(screen.getByText('🔄 OCR läuft…')).toBeInTheDocument());
  });
});
