import React, { useCallback, useState, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import {
  Box, Typography, Paper, Button, IconButton, Select, MenuItem,
  FormControl, InputLabel, Snackbar, Alert,
} from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { motion } from 'framer-motion';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloseIcon from '@mui/icons-material/Close';
import CircularProgress from '@mui/material/CircularProgress';
import PageHeader from '../components/PageHeader';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DownloadIcon from '@mui/icons-material/Download';

// ======== NEU: Hilfsfunktionen wie in Analyses.tsx ========
const LS_PREFIX = "run-view:";

declare global { interface Window { __ENV__?: any } }
function getPipelineApiBase(): string {
  const w = (window as any);
  return w.__ENV__?.PIPELINE_API_URL || import.meta.env?.VITE_PIPELINE_API_URL || '/pl';
}

function normalizeRunShape(run: any | undefined | null): any {
  if (!run || typeof run !== 'object') return run;
  const n: any = { ...run };
  if (n.overall_score === undefined && typeof n.overallScore === 'number') n.overall_score = n.overallScore;
  if (!n.scores && n.final_scores && typeof n.final_scores === 'object') n.scores = n.final_scores;
  if (!n.decisions && n.final_decisions && typeof n.final_decisions === 'object') n.decisions = n.final_decisions;
  if (n.extracted == null) n.extracted = {};
  if (n.scores == null) n.scores = {};
  if (n.decisions == null) n.decisions = {};
  if (!Array.isArray(n.log) && n.log != null) n.log = [];
  return n;
}

async function resolveRunIdIfMissing(normalized: any, pdfId: number, pipelineId: string): Promise<string | undefined> {
  const direct = normalized?.run_id ?? normalized?.id ?? normalized?.runId;
  if (typeof direct === 'string') return direct;

  const api = getPipelineApiBase();
  const candidates = [
    `${api}/runs/latest?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}`,
    `${api}/runs?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=1`,
    `${api}/runs/last?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}`,
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const json = await r.json();
      if (json && typeof json === 'object') {
        if (typeof json.run_id === 'string') return json.run_id;
        if (typeof json.id === 'string') return json.id;
        if (Array.isArray(json) && json[0]) {
          const first = json[0];
          if (typeof first?.run_id === 'string') return first.run_id;
          if (typeof first?.id === 'string') return first.id;
        }
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

async function fetchConsolidatedRun(pdfId: number, pipelineId: string): Promise<any | undefined> {
  const api = getPipelineApiBase();
  const candidates = [
    `${api}/runs/full?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=1`,
    `${api}/runs?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(pipelineId)}&limit=1`,
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const json = await r.json();
      if (json && typeof json === 'object') {
        if (json.extracted || json.scores || json.decisions) return normalizeRunShape(json);
        if (Array.isArray(json) && json.length > 0) {
          const first = json[0];
          if (first && typeof first === 'object') return normalizeRunShape(first);
        }
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

async function saveToLocalStorageAndOpen(runRaw: any, pdfUrl: string | undefined, pdfId: number, pipelineId: string) {
  const key = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  const normalized = normalizeRunShape(runRaw) ?? null;

  // 1) erst Roh/normalisiert speichern, damit die Seite sofort was hat
  let payload = { run: normalized, pdfUrl: pdfUrl ?? "" };
  try {
    localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(payload));
  } catch (e) {
    console.warn("LocalStorage write failed:", e);
  }

  // 2) run_id auflösen (bevorzugt)
  let runId: string | undefined;
  try { runId = await resolveRunIdIfMissing(normalized, pdfId, pipelineId); } catch {}

  // 3) falls keine run_id und keine Finals: konsolidiertes DTO holen und LS ersetzen
  const hasFinals =
      !!(normalized &&
          (Object.keys(normalized.extracted ?? {}).length > 0 ||
              Object.keys(normalized.scores ?? {}).length > 0 ||
              Object.keys(normalized.decisions ?? {}).length > 0));

  if (!runId && !hasFinals) {
    const finalRun = await fetchConsolidatedRun(pdfId, pipelineId);
    if (finalRun &&
        (Object.keys(finalRun.extracted ?? {}).length > 0 ||
            Object.keys(finalRun.scores ?? {}).length > 0 ||
            Object.keys(finalRun.decisions ?? {}).length > 0)) {
      payload = { run: finalRun, pdfUrl: pdfUrl ?? "" };
      try { localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(payload)); } catch {}
      runId = finalRun.run_id ?? finalRun.id ?? runId;
    }
  }

  const q = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
  window.open(`/run-view/${key}${q}`, "_blank", "noopener,noreferrer");
}
// ======== ENDE Hilfsfunktionen ========

type Pipeline = { id: string; name: string };

type UploadEntry = {
  id: number;
  file: File;
  fileName: string;
  selectedPipelineId?: string;
  status: 'ready' | 'uploading' | 'uploaded' | 'running' | 'completed' | 'error';
  pdfId?: number;
  pdfUrl?: string;
  result?: any; // PipelineRunResult | raw
};

export default function Upload() {
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [snackOpen, setSnackOpen] = useState(false);

  const updateFile = useCallback((id: number, patch: Partial<UploadEntry>) => {
    setEntries(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  // Pipelines laden
  useEffect(() => {
    const base = (window as any).__ENV__?.PIPELINE_API_URL || import.meta.env?.VITE_PIPELINE_API_URL || '/pl';
    fetch(`${base}/pipelines`)
    .then(r => r.json())
    .then((arr: any[]) => setPipelines(arr.map(p => ({ id: p.id, name: p.name }))))
    .catch(() => setPipelines([]));
  }, []);

  // Dropzone
  const onDrop = useCallback((files: File[]) => {
    const newRows: UploadEntry[] = files.map((f, idx) => ({
      id: Date.now() + idx,
      file: f,
      fileName: f.name,
      status: 'ready',
    }));
    setEntries(prev => [...newRows, ...prev]);
  }, []);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  // Tabelle
  const columns: GridColDef[] = [
    { field: 'fileName', headerName: 'Datei', width: 240 },
    {
      field: 'pipeline',
      headerName: 'Pipeline',
      width: 200,
      renderCell: params => (
          <Select
              size="small"
              fullWidth
              value={params.row.selectedPipelineId || ''}
              onChange={e => updateFile(params.row.id, { selectedPipelineId: String(e.target.value) })}
          >
            {pipelines.map(p => (
                <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
            ))}
          </Select>
      ),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 140,
      renderCell: p => <Typography variant="body2">{p.row.status}</Typography>,
    },
    {
      field: 'actions',
      headerName: 'Aktionen',
      width: 260,
      renderCell: params => {
        const row: UploadEntry = params.row;
        const running = row.status === 'running' || row.status === 'uploading';

        return (
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button
                  size="small"
                  variant="contained"
                  startIcon={<PlayArrowIcon />}
                  disabled={!row.selectedPipelineId || running}
                  onClick={() => runPipeline(row)}
              >
                Start
              </Button>
              <IconButton
                  size="small"
                  onClick={() => setEntries(prev => prev.filter(e => e.id !== row.id))}
                  title="Entfernen"
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
              {row.status === 'completed' && row.result && (
                  <Button
                      size="small"
                      variant="outlined"
                      startIcon={<VisibilityIcon />}
                      onClick={() => {
                        void saveToLocalStorageAndOpen(
                            row.result,
                            row.pdfUrl,
                            row.pdfId ?? 0,
                            row.selectedPipelineId || ''
                        );
                      }}
                  >
                    Details
                  </Button>
              )}
            </Box>
        );
      },
    },
  ];

  async function runPipeline(row: UploadEntry) {
    const base = (window as any).__ENV__?.PIPELINE_API_URL || import.meta.env?.VITE_PIPELINE_API_URL || '/pl';
    if (!row.selectedPipelineId) return;

    try {
      updateFile(row.id, { status: 'uploading' });

      // 1) PDF hochladen
      const fd = new FormData();
      fd.append('file', row.file);
      const upRes = await fetch(`${base}/pdfs`, { method: 'POST', body: fd });
      if (!upRes.ok) throw new Error(`Upload failed ${upRes.status}`);
      const upJson = await upRes.json(); // { pdf_id, pdf_url? }
      const pdfId: number = upJson.id ?? upJson.pdf_id;
      const pdfUrl: string | undefined = upJson.url ?? upJson.pdf_url;

      updateFile(row.id, { status: 'running', pdfId, pdfUrl });

      // 2) Pipeline triggern
      const startRes = await fetch(`${base}/pipelines/${row.selectedPipelineId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdf_id: pdfId }),
      });
      if (!startRes.ok) throw new Error(`Run start failed ${startRes.status}`);

      // 3) Ergebnis abholen (vereinfachte Variante – ggf. WebSocket/Polling ersetzen)
      //    Wir nehmen hier an, dass die API synchron das Roh-Ergebnis zurückgibt
      const resultRaw = await startRes.json();

      // *** WICHTIG: Ergebnis NICHT verschlanken – vollständig speichern ***
      const normalized = normalizeRunShape(resultRaw);
      updateFile(row.id, { status: 'completed', result: normalized });

      // Optional: Direkt Details öffnen
      // await saveToLocalStorageAndOpen(normalized, pdfUrl, pdfId, row.selectedPipelineId!);
    } catch (e) {
      console.error('runPipeline error', e);
      setSnackOpen(true);
      updateFile(row.id, { status: 'error' });
    }
  }

  return (
      <Box sx={{ p: 2 }}>
        <PageHeader title="Upload & Analyse" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Upload' }]} />
        <Paper
            variant="outlined"
            sx={{
              p: 3,
              mb: 2,
              borderStyle: 'dashed',
              textAlign: 'center',
              background: isDragActive ? 'rgba(25,118,210,0.06)' : 'transparent',
            }}
            {...getRootProps()}
        >
          <input {...getInputProps()} />
          <CloudUploadIcon sx={{ fontSize: 48, mb: 1 }} />
          <Typography variant="h6">PDFs hierher ziehen oder klicken</Typography>
          <Typography variant="body2" color="text.secondary">
            Unterstützt: PDF • mehrere Dateien möglich
          </Typography>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <DataGrid
              autoHeight
              rows={entries}
              columns={columns}
              pageSizeOptions={[5, 10, 25]}
              initialState={{ pagination: { paginationModel: { pageSize: 5, page: 0 } } }}
          />
        </Paper>

        <Snackbar open={snackOpen} autoHideDuration={6000} onClose={() => setSnackOpen(false)}>
          <Alert onClose={() => setSnackOpen(false)} severity="error" sx={{ width: '100%' }}>
            Statusaktualisierung fehlgeschlagen, versuche erneut
          </Alert>
        </Snackbar>
      </Box>
  );
}
