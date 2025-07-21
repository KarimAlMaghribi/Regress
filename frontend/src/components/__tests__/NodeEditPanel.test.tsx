import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import NodeEditPanel from '../NodeEditPanel';

const baseNode = {
  id: 'n1',
  type: 'default',
  position: { x: 0, y: 0 },
  data: { label: 'old', text: 'text', type: 'TriggerPrompt' },
};

describe('NodeEditPanel', () => {
  it('allows editing label and text', async () => {
    const onSave = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => [] }));
    render(<NodeEditPanel node={baseNode as any} onSave={onSave} />);
    const labelInput = screen.getByRole('textbox', { name: 'Label' });
    fireEvent.change(labelInput, { target: { value: 'New Label' } });
    const textInput = screen.getByRole('textbox', { name: 'Text' });
    fireEvent.change(textInput, { target: { value: 'New Text' } });
    fireEvent.click(screen.getByLabelText('Save Node'));
    expect(onSave).toHaveBeenCalledWith('n1', expect.objectContaining({ label: 'New Label', text: 'New Text' }));
  });
});
