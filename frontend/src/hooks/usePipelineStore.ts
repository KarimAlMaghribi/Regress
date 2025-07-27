import create from 'zustand';

export interface PipelineStep {
  id: string;
  type?: string;
  promptId?: number;
  alias?: string;
  inputs?: string[];
  formula_override?: string;
  input_source?: string;
  condition?: string;
  true_target?: string;
  false_target?: string;
  enum_targets?: Record<string,string>;
  active?: boolean;
}

interface PipelineState {
  name: string;
  steps: PipelineStep[];
  currentPipelineId?: string;
  dirty: boolean;
  addStepAt: (idx: number) => void;
  updateStep: (id: string, data: Partial<PipelineStep>) => void;
  moveStep: (src: number, dst: number) => void;
  removeStep: (id: string) => void;
  loadSteps: (steps: PipelineStep[], id?: string, name?: string) => void;
  setName: (name: string) => void;
  markDirty: (d: boolean) => void;
}

export const usePipelineStore = create<PipelineState>(set => ({
  name: '',
  steps: [],
  dirty: false,
  addStepAt: idx => set(state => {
    const step: PipelineStep = { id: Math.random().toString(36).slice(2) };
    const steps = [...state.steps];
    steps.splice(idx, 0, step);
    return { steps, dirty: true };
  }),
  updateStep: (id, data) => set(state => ({
    steps: state.steps.map(s => s.id === id ? { ...s, ...data } : s),
    dirty: true,
  })),
  moveStep: (src, dst) => set(state => {
    const steps = [...state.steps];
    const [s] = steps.splice(src, 1);
    steps.splice(dst, 0, s);
    return { steps, dirty: true };
  }),
  removeStep: id => set(state => ({
    steps: state.steps.filter(s => s.id !== id),
    dirty: true,
  })),
  loadSteps: (steps, id, name) => set({
    steps,
    currentPipelineId: id,
    name: name || '',
    dirty: false,
  }),
  setName: name => set({ name, dirty: true }),
  markDirty: dirty => set({ dirty }),
}));

export function validatePipeline(steps: PipelineStep[]): string[] {
  const errors: string[] = [];
  const aliases = new Set<string>();
  steps.forEach((s, idx) => {
    if (!s.type) errors.push(`Step ${idx + 1}: type missing`);
    if (s.type === 'ExtractionPrompt' && !s.alias) errors.push(`Step ${idx + 1}: alias required`);
    if (s.type === 'DecisionPrompt' && !s.condition && !s.enum_targets) {
      errors.push(`Step ${idx + 1}: condition or enum_targets required`);
    }
    if (s.alias) {
      if (aliases.has(s.alias)) errors.push(`duplicate alias ${s.alias}`);
      aliases.add(s.alias);
    }
  });
  return errors;
}
