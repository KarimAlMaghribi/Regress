import create from 'zustand';

const API = import.meta.env.VITE_API_URL || 'http://localhost:8084';
const INGEST = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';

export interface UploadEntry {
  id: number;
  pdfId: number | null;
  status: string;
  pdfUrl: string;
  ocr: boolean;
  layout: boolean;
  selectedPipelineId?: string;
  loading?: boolean;
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
    const ingest = INGEST;
    const [uploadData, texts] = await Promise.all([
      fetch(`${ingest}/uploads`).then(r => r.json()),
      fetch('http://localhost:8083/texts').then(r => r.json()),
    ]);
    const ocrIds = (texts as { id: number }[]).map(t => t.id);
    const mapped: UploadEntry[] = uploadData.map((d: any) => ({
      id: d.id,
      pdfId: d.pdf_id ?? null,
      status: d.status,
      pdfUrl: d.pdf_id ? `${ingest}/pdf/${d.pdf_id}` : '',
      ocr: d.pdf_id ? ocrIds.includes(d.pdf_id) : false,
      layout: d.status === 'ready',
      selectedPipelineId: '',
    }));
    set({ entries: mapped });
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
    set(state => ({
      entries: state.entries.map(e =>
        e.id === fileId ? { ...e, loading: true } : e
      ),
    }));
    const res = await fetch(`${API}/pipelines/${pipelineId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });

    // Log status and headers of the response
    console.log('⛽️ Pipeline run response:', {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
    });

    // Read raw body and try to parse JSON manually
    const raw = await res.text();
    console.log('📦 Raw response body:', raw);
    let data: any = {};
    const contentType = res.headers.get('content-type') || '';
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
    set(state => ({
      entries: state.entries.map(e =>
        e.id === fileId ? { ...e, loading: false } : e
      ),
    }));
    if (!res.ok) throw new Error((data.error as string) || `HTTP ${res.status}`);
  },
  async downloadExtractedText(fileId) {
    const res = await fetch(`${INGEST}/uploads/${fileId}/extract`);
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
