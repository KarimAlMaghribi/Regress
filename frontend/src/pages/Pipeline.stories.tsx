import type { Meta, StoryObj } from '@storybook/react';
import Pipeline from './Pipeline';
import { MemoryRouter } from 'react-router-dom';
import { examplePipeline } from '../types/PipelineGraph';

const meta: Meta<typeof Pipeline> = {
  title: 'Pipeline/Complex Pipeline',
  component: Pipeline,
};
export default meta;

const loopPipeline = {
  ...examplePipeline,
  edges: [
    ...examplePipeline.edges,
    { source: 'decision_1', target: 'analysis_1', type: 'onFalse' },
  ],
};

export const Complex: StoryObj = {
  render: () => (
    <MemoryRouter>
      <Pipeline initial={loopPipeline} />
    </MemoryRouter>
  ),
};
