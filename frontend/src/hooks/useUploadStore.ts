import create from 'zustand';

import {API_BASE, INGEST_API, PDF_OPEN_BASE} from '../utils/api';

export type AnyRun = Record<string, any>;

function countKeys(o: any): number {
  return o && typeof o === 'object' ? Object.keys(o).length : 0;
}

function normalizeRunShape(run: AnyRun | null | undefined): AnyRun {
  if (!run || typeof run !== 'object') return {};
  const normalized: AnyRun = { ...run };
  if (normalized.overall_score === undefined && typeof normalized.overallScore === 'number') normalized.overall_score = normalized.overallScore;
  if (!normalized.scores && normalized.final_scores && typeof normalized.final_scores === 'object') normalized.scores = normalized.final_scores;
  if (!normalized.decisions && normalized.final_decisions && typeof normalized.final_decisions === 'object') normalized.decisions = normalized.final_decisions;
  if (normalized.extracted == null) normalized.extracted = {};
  if (normalized.scores == null) normalized.scores = {};
  if (normalized.decisions == null) normalized.decisions = {};
  if (!Array.isArray(normalized.log) && normalized.log != null) normalized.log = [];
  return normalized;
}

function mergeRunPreferRicher(oldRunRaw: AnyRun | null | undefined, incomingRunRaw: AnyRun | null | undefined): AnyRun {
  const oldRun = normalizeRunShape(oldRunRaw);
  const incomingRun = normalizeRunShape(incomingRunRaw);
  const merged: AnyRun = { ...oldRun, ...incomingRun };

  if (countKeys(incomingRun.extracted) === 0 && countKeys(oldRun.extracted) > 0) merged.extracted = oldRun.extracted;
  if (countKeys(incomingRun.scores) === 0 && countKeys(oldRun.scores) > 0) merged.scores = oldRun.scores;
  if (countKeys(incomingRun.decisions) === 0 && countKeys(oldRun.decisions) > 0) merged.decisions = oldRun.decisions;

  if ((incomingRun.overall_score === null || incomingRun.overall_score === undefined) &&
      (oldRun.overall_score !== null && oldRun.overall_score !== undefined)) {
    merged.overall_score = oldRun.overall_score;
  }

  merged.run_id = incomingRun.run_id ?? oldRun.run_id ?? incomingRun.id ?? oldRun.id;

  const dedupeJSON = (arr?: any[]) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: any[] = [];
    for (const item of arr) {
      const key = JSON.stringify(item ?? null);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
    return out;
  };

  merged.extraction = dedupeJSON([...(oldRun.extraction || []), ...(incomingRun.extraction || [])]);
  merged.scoring = dedupeJSON([...(oldRun.scoring || []), ...(incomingRun.scoring || [])]);
  merged.decision = dedupeJSON([...(oldRun.decision || []), ...(incomingRun.decision || [])]);
  merged.log = dedupeJSON([...(oldRun.log || []), ...(incomingRun.log || [])]);

  return merged;
}

export interface UploadEntry {
  id: number;
  pdfId: number | null;
  status: string;
  pdfUrl: string;
  ocr: boolean;
  layout: boolean;
  displayName: string;
  sourceNames: string[];
  selectedPipelineId?: string;
  loading?: boolean;
  result?: AnyRun;
  runId?: string;
}

interface UploadState {
  entries: UploadEntry[];
  error?: string;
  autoRefreshId?: number;
  load: () => Promise<void>;
  updateFile: (id: number, changes: Partial<UploadEntry>) => void;
  runPipeline: (fileId: number, pipelineId: string) => Promise<void>;
  downloadExtractedText: (fileId: number) => Promise<void>;
  startAutoRefresh: (intervalMs: number) => void;
  stopAutoRefresh: () => void;
}

export const useUploadStore = create<UploadState>((set, get) => ({
  entries: [],
  error: undefined,
  autoRefreshId: undefined,

  async load() {
    const ingest = INGEST_API;
    const pdfBase = PDF_OPEN_BASE;
    try {
      const [uploadData, texts] = await Promise.all([
        fetch(`${ingest.replace(/\/$/, '')}/uploads`).then(r => r.json()),
        fetch('http://localhost:8083/texts').then(r => r.json()).catch(() => [] as any[]),
      ]);

      const prevEntries = get().entries;
      const ocrIds = (texts as { id: number }[]).map(t => t.id);
      const nextEntries: UploadEntry[] = (uploadData as any[]).map((item: any) => {
        const names: string[] = Array.isArray(item.names) ? item.names : [];
        const fallbackName = item.pdf_id ? `PDF #${item.pdf_id}` : `Upload ${item.id}`;
        return {
          id: item.id,
          pdfId: item.pdf_id ?? null,
          status: item.status,
          pdfUrl: item.pdf_id ? `${pdfBase.replace(/\/$/, '')}/pdf/${item.pdf_id}` : '',
          ocr: item.pdf_id ? ocrIds.includes(item.pdf_id) : false,
          layout: item.status === 'ready',
          displayName: names[0] ?? fallbackName,
          sourceNames: names,
          selectedPipelineId: '',
          result: undefined,
          runId: undefined,
        };
      });

      const byId = new Map<number, UploadEntry>(prevEntries.map(entry => [entry.id, entry]));
      const merged = nextEntries.map(entry => {
        const oldEntry = byId.get(entry.id);
        if (!oldEntry) return entry;

        const keepLoading = oldEntry.loading && entry.status !== 'ready';
        return {
          ...oldEntry,
          ...entry,
          displayName: entry.displayName || oldEntry.displayName,
          sourceNames: entry.sourceNames.length ? entry.sourceNames : oldEntry.sourceNames ?? [],
          selectedPipelineId: oldEntry.selectedPipelineId ?? entry.selectedPipelineId,
          loading: keepLoading || false,
          result: mergeRunPreferRicher(oldEntry.result, (entry as any).result),
          runId: oldEntry.runId ?? entry.runId,
        };
      });

      set({ entries: merged, error: undefined });
    } catch (err) {
      console.error('load uploads', err);
      set({ error: (err as Error).message });
    }
  },

  startAutoRefresh(intervalMs) {
    if (get().autoRefreshId) return;
    const id = window.setInterval(async () => {
      try {
        await get().load();
        set({ error: undefined });
        const allReady = get().entries.every(entry => entry.status === 'ready');
        if (allReady) {
          clearInterval(id);
          set({ autoRefreshId: undefined });
        }
      } catch (err) {
        console.error('auto refresh', err);
        set({ error: (err as Error).message });
      }
    }, intervalMs);
    set({ autoRefreshId: id });
  },

  stopAutoRefresh() {
    const id = get().autoRefreshId;
    if (!id) return;
    clearInterval(id);
    set({ autoRefreshId: undefined });
  },

  updateFile(id, changes) {
    set(state => ({
      entries: state.entries.map(entry => (entry.id === id ? { ...entry, ...changes } : entry)),
    }));
  },

  async runPipeline(fileId, pipelineId) {
    if (!pipelineId) return;

    set(state => ({
      entries: state.entries.map(entry => (entry.id === fileId ? { ...entry, loading: true } : entry)),
    }));

    const response = await fetch(`${API_BASE.replace(/\/$/, '')}/pipelines/${pipelineId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });

    const rawBody = await response.text();
    const contentType = response.headers.get('content-type') || '';
    let parsed: AnyRun | undefined = undefined;
    if (rawBody && contentType.includes('application/json')) {
      try {
        parsed = JSON.parse(rawBody);
      } catch (err) {
        console.warn('JSON parse failed for pipeline response', err);
      }
    }

    set(state => ({
      entries: state.entries.map(entry => {
        if (entry.id !== fileId) return entry;
        const mergedRun = mergeRunPreferRicher(entry.result, parsed);
        const runId = (parsed as any)?.run_id ?? (parsed as any)?.id ?? entry.runId;
        return { ...entry, loading: false, result: mergedRun, runId };
      }),
    }));

    if (!response.ok) {
      throw new Error(((parsed as any)?.error as string) || `HTTP ${response.status}`);
    }
  },

  async downloadExtractedText(fileId) {
    const res = await fetch(`${INGEST_API.replace(/\/$/, '')}/uploads/${fileId}/extract`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `extracted_${fileId}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
}));
