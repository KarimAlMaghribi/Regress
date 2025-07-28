import create from 'zustand';

export interface PipelineStep {
  id: string;
  label?: string;
  type: string;
  promptId: number;
  input_source?: string;
  alias?: string;
  inputs?: string[];
  formula_override?: string;
  condition?: string;
  true_target?: string;
  false_target?: string;
  enum_targets?: Record<string, string>;
  active?: boolean;
}

interface PipelineState {
  name: string;
  steps: PipelineStep[];
  currentPipelineId?: string;
  dirty: boolean;
  loadPipeline: (id: string) => Promise<void>;
  createPipeline: (name: string) => Promise<void>;
  updateName: (name: string) => Promise<void>;
  addStepAt: (index: number, step: PipelineStep) => Promise<void>;
  updateStep: (id: string, changes: Partial<PipelineStep>) => Promise<void>;
  reorder: (order: string[]) => Promise<void>;
  removeStep: (id: string) => Promise<void>;
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:8084';

async function publishUpdate(id: string) {
  try {
    await fetch(`${API}/pipeline-runner/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_id: id }),
    });
  } catch (err) {
    console.error('publish update', err);
  }
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  name: '',
  steps: [],
  dirty: false,

  async loadPipeline(id) {
    const res = await fetch(`${API}/pipelines/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    set({ name: json.name, steps: json.steps, currentPipelineId: id, dirty: false });
  },

  async createPipeline(name) {
    const res = await fetch(`${API}/pipelines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, steps: [] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    set({ name: json.name, steps: json.steps, currentPipelineId: json.id, dirty: false });
    await publishUpdate(json.id);
  },

  async updateName(name) {
    const id = get().currentPipelineId;
    if (!id) {
      set({ name });
      return;
    }
    const prev = get().name;
    set({ name });
    const res = await fetch(`${API}/pipelines/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      set({ name: prev });
      throw new Error(`HTTP ${res.status}`);
    }
    await publishUpdate(id);
  },

  async addStepAt(index, step) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const next = [...prev];
    next.splice(index, 0, step);
    set({ steps: next });
    const res = await fetch(`${API}/pipelines/${id}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index, step }),
    });
    if (!res.ok) {
      set({ steps: prev });
      throw new Error(`HTTP ${res.status}`);
    }
    await publishUpdate(id);
  },

  async updateStep(stepId, changes) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const next = prev.map(s => (s.id === stepId ? { ...s, ...changes } : s));
    set({ steps: next });
    const res = await fetch(`${API}/pipelines/${id}/steps/${stepId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    if (!res.ok) {
      set({ steps: prev });
      throw new Error(`HTTP ${res.status}`);
    }
    await publishUpdate(id);
  },

  async removeStep(stepId) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const next = prev.filter(s => s.id !== stepId);
    set({ steps: next });
    const res = await fetch(`${API}/pipelines/${id}/steps/${stepId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      set({ steps: prev });
      throw new Error(`HTTP ${res.status}`);
    }
    await publishUpdate(id);
  },

  async reorder(order) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const map = new Map(prev.map(s => [s.id, s]));
    const next: PipelineStep[] = [];
    order.forEach(o => { const s = map.get(o); if (s) next.push(s); });
    set({ steps: next });
    const res = await fetch(`${API}/pipelines/${id}/steps/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    if (!res.ok) {
      set({ steps: prev });
      throw new Error(`HTTP ${res.status}`);
    }
    await publishUpdate(id);
  },
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
