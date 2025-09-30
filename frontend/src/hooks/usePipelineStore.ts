import create from 'zustand';

export interface PipelineStep {
  id: string;
  type: 'ExtractionPrompt' | 'ScoringPrompt' | 'DecisionPrompt';
  promptId: number;
  /** Wizard keys for DecisionPrompts */
  yesKey?: string;
  noKey?: string;
  route?: string;
  active?: boolean;
  /** Freie JSON-Config pro Step (z. B. { min_signal: 0.5 }) */
  config?: Record<string, unknown>;
}

interface PipelineState {
  name: string;
  steps: PipelineStep[];
  currentPipelineId?: string;
  dirty: boolean;
  listPipelines: () => Promise<Array<{id:string;name:string}>>;
  deletePipeline: (id: string) => Promise<void>;
  loadPipeline: (id: string) => Promise<void>;
  createPipeline: (name: string) => Promise<string>;
  updateName: (name: string) => Promise<void>;
  addStepAt: (index: number, step: PipelineStep) => Promise<void>;
  updateStep: (id: string, changes: Partial<PipelineStep>) => Promise<void>;
  reorder: (order: string[]) => Promise<void>;
  removeStep: (id: string) => Promise<void>;
  confirmIfDirty: () => boolean;
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:8084';

export const usePipelineStore = create<PipelineState>((set, get) => ({
  name: '',
  steps: [],
  dirty: false,

  async listPipelines() {
    const res = await fetch(`${API}/pipelines`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },

  async deletePipeline(id) {
    const res = await fetch(`${API}/pipelines/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (get().currentPipelineId === id) {
      set({ currentPipelineId: undefined, name: '', steps: [] });
    }
  },

  async loadPipeline(id) {
    const res = await fetch(`${API}/pipelines/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const steps: PipelineStep[] = (json.steps || []).map((s: any) => ({
      id: s.id,
      type: s.type,
      promptId: s.promptId ?? s.prompt_id,
      yesKey: (s.yesKey ?? s.yes_key) || undefined,
      noKey: (s.noKey ?? s.no_key) || undefined,
      route: s.route || undefined,
      active: s.active !== false,
      // WICHTIG: config aus dem Backend übernehmen
      config: s.config ?? undefined,
    }));
    set({ name: json.name, steps, currentPipelineId: id, dirty: false });
  },

  async createPipeline(name) {
    const res = await fetch(`${API}/pipelines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, steps: [] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const steps: PipelineStep[] = (json.steps || []).map((s: any) => ({
      id: s.id,
      type: s.type,
      promptId: s.promptId ?? s.prompt_id,
      yesKey: (s.yesKey ?? s.yes_key) || undefined,
      noKey: (s.noKey ?? s.no_key) || undefined,
      route: s.route || undefined,
      active: s.active !== false,
      config: s.config ?? undefined,
    }));
    set({ name: json.name, steps, currentPipelineId: json.id, dirty: false });
    return json.id as string;
  },

  async updateName(name) {
    const id = get().currentPipelineId;
    if (!id) {
      set({ name, dirty: true });
      return;
    }
    // ⚠️ Sicherer Name-Update: wenn dein Backend beim PUT die komplette Pipeline erwartet,
    // dann sende vollständiges Objekt. Falls es Name-only unterstützt, ist das ebenfalls ok.
    const payload = {
      name,
      steps: get().steps.map(s => ({
        id: s.id,
        type: s.type,
        promptId: s.promptId,
        route: s.route ?? null,
        yesKey: s.yesKey ?? null,
        noKey: s.noKey ?? null,
        active: s.active !== false,
        ...(s.config ? { config: s.config } : {}),
      })),
    };

    const prev = get().name;
    set({ name, dirty: true });
    const res = await fetch(`${API}/pipelines/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), // ← vollständige Pipeline senden
    });
    if (!res.ok) {
      set({ name: prev, dirty: true });
      throw new Error(`HTTP ${res.status}`);
    }
    set({ dirty: false });
  },

  async addStepAt(index, step) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const safeIndex = Math.min(index, prev.length);
    const next = [...prev];
    next.splice(safeIndex, 0, step);
    set({ steps: next, dirty: true });

    // Step inkl. config an Backend schicken
    const res = await fetch(`${API}/pipelines/${id}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: safeIndex, step }),
    });
    if (!res.ok) {
      set({ steps: prev, dirty: true });
      throw new Error(`HTTP ${res.status}`);
    }
    set({ dirty: false });
  },

  async updateStep(stepId, changes) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const next = prev.map(s => (s.id === stepId ? { ...s, ...changes } : s));
    set({ steps: next, dirty: true });

    // Patch inkl. möglicher config-Änderung
    const res = await fetch(`${API}/pipelines/${id}/steps/${stepId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    if (!res.ok) {
      set({ steps: prev, dirty: true });
      throw new Error(`HTTP ${res.status}`);
    }
    set({ dirty: false });
  },

  async removeStep(stepId) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const next = prev.filter(s => s.id !== stepId);
    set({ steps: next, dirty: true });
    const res = await fetch(`${API}/pipelines/${id}/steps/${stepId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      set({ steps: prev, dirty: true });
      throw new Error(`HTTP ${res.status}`);
    }
    set({ dirty: false });
  },

  async reorder(order) {
    const id = get().currentPipelineId;
    if (!id) throw new Error('no pipeline loaded');
    const prev = get().steps;
    const map = new Map(prev.map(s => [s.id, s]));
    const next: PipelineStep[] = [];
    order.forEach(o => { const s = map.get(o); if (s) next.push(s); });
    // ggf. restliche Steps anhängen (falls order unvollständig)
    if (next.length !== prev.length) {
      prev.forEach(s => { if (!order.includes(s.id)) next.push(s); });
    }
    set({ steps: next, dirty: true });

    const res = await fetch(`${API}/pipelines/${id}/steps/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    });
    if (!res.ok) {
      set({ steps: prev, dirty: false });
      throw new Error(`HTTP ${res.status}`);
    }
    set({ dirty: false });
  },

  confirmIfDirty() {
    if (get().dirty && !window.confirm('Ungespeicherte Änderungen verwerfen?')) return false;
    return true;
  }
}));

export function validatePipeline(steps: PipelineStep[]): string[] {
  const errors: string[] = [];
  steps.forEach((s, idx) => {
    if (!s.type) errors.push(`Step ${idx + 1}: type missing`);
    if (s.type === 'DecisionPrompt') {
      if (!s.yesKey || !s.noKey) {
        errors.push(`Step ${idx + 1}: decision keys required`);
      }
    }
  });
  return errors;
}
