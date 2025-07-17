import type { Meta, StoryObj } from '@storybook/react';
import Result from './Result';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const meta: Meta<typeof Result> = {
  title: 'Result',
  component: Result,
};
export default meta;

const qc = new QueryClient();

const Wrapper = ({ data }: { data: any }) => {
  qc.setQueryData(`/runs/1`, data);
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/result/1']}>
        <Routes>
          <Route path="/result/:id" element={<Result />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
};

export const Success: StoryObj = {
  render: () => (
    <Wrapper
      data={{ score: 0.9, label: 'KEIN_REGRESS', history: [{ prompt_id: 'A1', prompt_type: 'Final', answer: 'ok', source: 'src.pdf' }] }}
    />
  ),
};

export const Warning: StoryObj = {
  render: () => (
    <Wrapper
      data={{ score: 0.65, label: 'MÖGLICHER_REGRESS', history: [{ prompt_id: 'A1', prompt_type: 'Decision', answer: 'hmm', source: 'src.pdf' }] }}
    />
  ),
};

export const Error: StoryObj = {
  render: () => (
    <Wrapper
      data={{ score: 0.3, label: 'SICHER_REGRESS', history: [{ prompt_id: 'A1', prompt_type: 'Analysis', answer: 'bad', source: 'src.pdf' }] }}
    />
  ),
};
