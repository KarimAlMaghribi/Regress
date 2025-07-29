import { useEffect } from 'react';
import create from 'zustand';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8084';

interface Pipeline {
  id: string;
  name: string;
}

interface PipelineListState {
  pipelines: Pipeline[];
  loaded: boolean;
  load: () => Promise<void>;
}

const useStore = create<PipelineListState>((set) => ({
  pipelines: [],
  loaded: false,
  async load() {
    const res = await fetch(`${API}/pipelines`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    set({ pipelines: data, loaded: true });
  },
}));

export function usePipelineList() {
  const { pipelines, loaded, load } = useStore();
  useEffect(() => { if (!loaded) load().catch(() => {}); }, [loaded, load]);
  return { pipelines, reload: load };
}
