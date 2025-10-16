import create from 'zustand';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8084';
type RuntimeEnv = {
  INGEST_URL?: string;
  UPLOAD_API_URL?: string;
};

const runtimeEnv: RuntimeEnv =
  (typeof window !== 'undefined'
    ? ((window as unknown as { __ENV__?: RuntimeEnv }).__ENV__ ?? {})
    : {});

export const UPLOAD_API =
  runtimeEnv.UPLOAD_API_URL ||
  runtimeEnv.INGEST_URL ||
  (import.meta.env.VITE_API_URL as string | undefined) ||
  (import.meta.env.VITE_INGEST_URL as string | undefined) ||
    '/ingest';

type AnyRun = Record<string, any>;

/* --------------------------- helpers: run merge --------------------------- */

function countKeys(o: any): number {
  return o && typeof o === 'object' ? Object.keys(o).length : 0;
}

function normalizeRunShape(run: AnyRun | null | undefined): AnyRun {
  if (!run || typeof run !== 'object') return {};
  const n: AnyRun = { ...run };
  // camel → snake
  if (n.overall_score === undefined && typeof n.overallScore === 'number') n.overall_score = n.overallScore;
  if (!n.scores && n.final_scores && typeof n.final_scores === 'object') n.scores = n.final_scores;
  if (!n.decisions && n.final_decisions && typeof n.final_decisions === 'object') n.decisions = n.final_decisions;
  // leere Maps sicherstellen
  if (n.extracted == null) n.extracted = {};
  if (n.scores == null) n.scores = {};
  if (n.decisions == null) n.decisions = {};
  // arrays
  if (!Array.isArray(n.log) && n.log != null) n.log = [];
  return n;
}

/**
 * Bevorzuge das "reichere" Objekt:
 *  - extracted/scores/decisions: behalte vorhandene, wenn Neues leer ist
 *  - overall_score: behalte vorhandenen Nicht-Null Wert, wenn Neues null/undefined ist
 *  - log/extraction/scoring/decision: einfache Zusammenführung mit Dedupe
 *  - run_id/id: konservieren
 */
function mergeRunPreferRicher(oldRunRaw: AnyRun | null | undefined, incRunRaw: AnyRun | null | undefined): AnyRun {
  const oldRun = normalizeRunShape(oldRunRaw);
  const incRun = normalizeRunShape(incRunRaw);

  const merged: AnyRun = { ...oldRun, ...incRun };

  // Finals niemals durch leere Maps überschreiben
  if (countKeys(incRun.extracted) === 0 && countKeys(oldRun.extracted) > 0) merged.extracted = oldRun.extracted;
  if (countKeys(incRun.scores)    === 0 && countKeys(oldRun.scores)    > 0) merged.scores    = oldRun.scores;
  if (countKeys(incRun.decisions) === 0 && countKeys(oldRun.decisions) > 0) merged.decisions = oldRun.decisions;

  // overall_score konservieren, wenn Neues leer ist
  if ((incRun.overall_score === null || incRun.overall_score === undefined) &&
      (oldRun.overall_score !== null && oldRun.overall_score !== undefined)) {
    merged.overall_score = oldRun.overall_score;
  }

  // run_id/id konservieren
  merged.run_id = incRun.run_id ?? oldRun.run_id ?? incRun.id ?? oldRun.id;

  // Arrays deduplizieren
  const dedupeJSON = (arr?: any[]) => {
    if (!Array.isArray(arr)) return [];
    const seen = new Set<string>();
    const out: any[] = [];
    for (const x of arr) {
      const k = JSON.stringify(x ?? null);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    }
    return out;
  };

  merged.extraction = dedupeJSON([...(oldRun.extraction || []), ...(incRun.extraction || [])]);
  merged.scoring    = dedupeJSON([...(oldRun.scoring    || []), ...(incRun.scoring    || [])]);
  merged.decision   = dedupeJSON([...(oldRun.decision   || []), ...(incRun.decision   || [])]);
  merged.log        = dedupeJSON([...(oldRun.log        || []), ...(incRun.log        || [])]);

  return merged;
}

/* --------------------------- types / store API --------------------------- */

export interface UploadEntry {
  id: number;
  pdfId: number | null;
  status: string;
  pdfUrl: string;
  ocr: boolean;
  layout: boolean;
  selectedPipelineId?: string;
  loading?: boolean;
  // NEU: wir halten das (zusammengeführte) Run-Ergebnis am Eintrag
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

/* ------------------------------- the store ------------------------------- */

export const useUploadStore = create<UploadState>((set, get) => ({
  entries: [],
  error: undefined,
  autoRefreshId: undefined,

  async load() {
    const ingest = UPLOAD_API;
    const [uploadData, texts] = await Promise.all([
      fetch(`${ingest}/uploads`).then(r => r.json()),
      // OCR-Status über Gateway/Frontend‑Nginx
      fetch('/te/texts').then(r => r.json()).catch(() => [] as any[]),
    ]);

    const prev = get().entries;
    const ocrIds = (texts as { id: number }[]).map(t => t.id);

    // map neue Einträge
    const nextRaw: UploadEntry[] = (uploadData as any[]).map((d: any) => ({
      id: d.id,
      pdfId: d.pdf_id ?? null,
      status: d.status,
      pdfUrl: d.pdf_id ? `${ingest}/pdf/${d.pdf_id}` : '',
      ocr: d.pdf_id ? ocrIds.includes(d.pdf_id) : false,
      layout: d.status === 'ready',
      selectedPipelineId: '',
      // falls Backend bereits was mitliefert (selten), übernehmen:
      result: undefined,
      runId: undefined,
    }));

    // merge mit Bestand (behalte richer run / UI state)
    const byId = new Map<number, UploadEntry>(prev.map(e => [e.id, e]));
    const merged: UploadEntry[] = nextRaw.map(n => {
      const old = byId.get(n.id);
      if (!old) return n;
      const keepLoading = old.loading && n.status !== 'ready';
      return {
        ...old,
        ...n,
        selectedPipelineId: old.selectedPipelineId ?? n.selectedPipelineId,
        loading: keepLoading || false,
        result: mergeRunPreferRicher(old.result, (n as any).result),
        runId: old.runId ?? n.runId,
      };
    });

    set({ entries: merged, error: undefined });
  },

  startAutoRefresh(intervalMs) {
    if (get().autoRefreshId) return;
    const id = window.setInterval(async () => {
      try {
        await get().load();
        set({ error: undefined });
        const allReady = get().entries.every(e => e.status === 'ready');
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
    if (id) {
      clearInterval(id);
      set({ autoRefreshId: undefined });
    }
  },

  updateFile(id, changes) {
    set(state => ({
      entries: state.entries.map(e => (e.id === id ? { ...e, ...changes } : e)),
    }));
  },

  async runPipeline(fileId, pipelineId) {
    // UI: markiere loading
    set(state => ({
      entries: state.entries.map(e => e.id === fileId ? { ...e, loading: true } : e),
    }));

    const res = await fetch(`${API}/pipelines/${pipelineId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });

    // Debug: Status + Header + Raw Body
    console.log('⛽️ Pipeline run response:', {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
    });

    const raw = await res.text();
    console.log('📦 Raw response body:', raw);

    // Try parse JSON if announced as JSON
    const contentType = res.headers.get('content-type') || '';
    let data: AnyRun | undefined = undefined;
    if (raw && contentType.includes('application/json')) {
      try {
        data = JSON.parse(raw);
        console.log('🔍 Parsed JSON:', data);
      } catch (e) {
        console.warn('⚠️ JSON.parse fehlgeschlagen:', e);
      }
    } else if (!raw) {
      console.log('ℹ️ Empty response body, skipping JSON parse');
    } else {
      console.log('ℹ️ Non-JSON response body, skipping JSON parse');
    }

    // Update UI row: remove loading & merge possible result
    set(state => ({
      entries: state.entries.map(e => {
        if (e.id !== fileId) return e;
        const mergedRun = mergeRunPreferRicher(e.result, data);
        const runId = (data as any)?.run_id ?? (data as any)?.id ?? e.runId;
        return { ...e, loading: false, result: mergedRun, runId };
      }),
    }));

    if (!res.ok) {
      // Oberfläche informiert, Fehler fliegt hoch
      throw new Error(((data as any)?.error as string) || `HTTP ${res.status}`);
    }
  },

  async downloadExtractedText(fileId) {
    const res = await fetch(`${UPLOAD_API}/uploads/${fileId}/extract`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `extracted_${fileId}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
}));
