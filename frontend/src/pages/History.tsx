import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Paper, Typography, IconButton, Drawer, Stack, TextField, Chip,
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import PageHeader from '../components/PageHeader';
import VisibilityIcon from '@mui/icons-material/Visibility';
import OpenInNewIcon from '@mui/icons-material/OpenInNew'; // NEU
import dayjs, { Dayjs } from 'dayjs';
import { PipelineRunResult } from '../types/pipeline';
import RunDetails from '../components/RunDetails';

declare global {
  interface Window { __ENV__?: any }
}

const RUNTIME = (window as any).__ENV__ || {};
const BASE_HIST = RUNTIME.HISTORY_URL || import.meta.env.VITE_HISTORY_URL || '/hist';
const WS_URL =
    RUNTIME.HISTORY_WS ||
    import.meta.env.VITE_HISTORY_WS ||
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/histws`;

function getPipelineApiBase(): string {
  return RUNTIME.PIPELINE_API_URL || import.meta.env.VITE_PIPELINE_API_URL || '/pl';
}

const LS_PREFIX = 'run-view:'; // NEU

interface HistoryEntry {
  id: number; // unique analysis id
  pdfId: number;
  timestamp: string;
  result?: PipelineRunResult | any | null;
  pdfUrl: string;
  prompt?: string | null;
  status?: string;
  pipelineId?: string;
  pipelineName?: string;
}

/** snake/camel normalisieren (nur was wir brauchen) */
function normalizeRun(run: any | undefined | null) {
  if (!run || typeof run !== 'object') return run;
  const n: any = { ...run };
  if (n.overall_score === undefined && typeof n.overallScore === 'number') n.overall_score = n.overallScore;
  if (!n.scores && n.final_scores && typeof n.final_scores === 'object') n.scores = n.final_scores;
  if (!n.decisions && n.final_decisions && typeof n.final_decisions === 'object') n.decisions = n.final_decisions;
  if (n.extracted == null) n.extracted = {};
  if (n.scores == null) n.scores = {};
  if (n.decisions == null) n.decisions = {};
  return n;
}

function extractPipelineFromAny(e: any): { id?: string; name?: string } {
  const pick = (v: any) => (v != null ? String(v) : undefined);

  const fromTopId = pick(e?.pipeline_id ?? e?.pipelineId ?? e?.pipeline?.id);
  const fromTopName = e?.pipeline_name ?? e?.pipelineName ?? e?.pipeline?.name;

  const r = normalizeRun(e?.result ?? e?.run);
  const fromRunId = pick(r?.pipeline_id ?? r?.pipelineId ?? r?.pipeline?.id);
  const fromRunName = r?.pipeline_name ?? r?.pipelineName ?? r?.pipeline?.name;

  return {
    id: fromTopId ?? fromRunId,
    name: (typeof fromTopName === 'string' && fromTopName) ? fromTopName
        : (typeof fromRunName === 'string' && fromRunName) ? fromRunName
            : undefined,
  };
}

function normalizeEntry(e: any): HistoryEntry {
  const run = normalizeRun(e.result ?? e.run ?? undefined);
  const { id: pipelineId, name: pipelineName } = extractPipelineFromAny({ ...e, result: run });
  return {
    id: e.id ?? Date.now() + Math.random(),
    pdfId: e.pdf_id ?? e.pdfId ?? e.file_id ?? 0,
    pdfUrl: e.pdfUrl ?? e.pdf_url ?? '',
    timestamp: e.timestamp ?? e.created_at ?? new Date().toISOString(),
    result: run,
    prompt: e.prompt ?? null,
    status: e.status,
    pipelineId,
    pipelineName,
  };
}

async function fetchPipelineNameById(id: string): Promise<string | undefined> {
  const api = getPipelineApiBase();
  const candidates = [
    `${api}/pipelines/${encodeURIComponent(id)}`,
    `${api}/pipelines?id=${encodeURIComponent(id)}`,
  ];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j && typeof j === 'object' && typeof j.name === 'string') return j.name;
      if (Array.isArray(j)) {
        const hit = j.find((p: any) => String(p?.id ?? p?.pipeline_id) === String(id));
        if (hit && typeof hit.name === 'string') return hit.name;
      }
    } catch { /* ignore */ }
  }
  try {
    const r = await fetch(`${api}/pipelines`, { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr)) {
        const hit = arr.find((p: any) => String(p?.id ?? p?.pipeline_id) === String(id));
        if (hit && typeof hit.name === 'string') return hit.name;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

/** NEU: Öffnet RunDetailsPage in neuem Tab und legt Payload in localStorage ab */
async function openRunDetailsPageInNewTab(entry: HistoryEntry) {
  const key = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const run = normalizeRun(entry.result);

  const toNum = (v: any): number | undefined => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  let pdfId: number | undefined =
      toNum(entry.pdfId) ??
      toNum(run?.pdf_id) ??
      toNum(run?.pdfId) ??
      toNum((entry as any)?.result?.pdf_id) ??
      undefined;

  // Payload für Sofort-Render
  const payload: any = { run, pdfUrl: entry.pdfUrl };
  if (pdfId != null) payload.pdfId = pdfId;
  try {
    localStorage.setItem(`${LS_PREFIX}${key}`, JSON.stringify(payload));
  } catch (e) {
    console.warn('localStorage write failed', e);
  }

  // Optional: run_id bestimmen (falls vorhanden oder ableitbar)
  let runId: string | undefined = run?.run_id ?? run?.id;
  if (!runId && pdfId && entry.pipelineId) {
    const api = getPipelineApiBase();
    const url = `${api}/runs/latest?pdf_id=${encodeURIComponent(pdfId)}&pipeline_id=${encodeURIComponent(entry.pipelineId)}`;
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j === 'object') {
          runId = j.run_id ?? j.id ?? runId;
        }
      }
    } catch { /* ignore */ }
  }

  // URL bauen
  const qp = new URLSearchParams();
  if (pdfId != null) qp.set('pdf_id', String(pdfId));
  if (entry.pdfUrl) qp.set('pdf_url', entry.pdfUrl);
  if (runId) qp.set('run_id', runId);

  const url = `/run-view/${key}` + (qp.toString() ? `?${qp.toString()}` : '');
  window.open(url, '_blank', 'noopener,noreferrer');
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [search, setSearch] = useState('');
  const [start, setStart] = useState<Dayjs | null>(null);
  const [end, setEnd] = useState<Dayjs | null>(null);
  const [pipelineNames, setPipelineNames] = useState<Record<string, string>>({});

  // Initial REST Load (running + completed)
  useEffect(() => {
    const load = async () => {
      try {
        const [rRunning, rCompleted] = await Promise.all([
          fetch(`${BASE_HIST}/analyses?status=running`).then(r => r.json()),
          fetch(`${BASE_HIST}/analyses?status=completed`).then(r => r.json()),
        ]);
        const initial = [...rRunning, ...rCompleted].map(normalizeEntry);
        initial.sort((a, b) => dayjs(b.timestamp).valueOf() - dayjs(a.timestamp).valueOf());
        setEntries(initial);

        // pdfId aus Query übernehmen und Drawer öffnen
        const pdfIdParam = new URLSearchParams(location.search).get('pdfId');
        if (pdfIdParam) {
          const wanted = initial.find(e => String(e.pdfId) === pdfIdParam);
          if (wanted) setSelected(wanted);
        }
      } catch (e) {
        console.error('history initial load failed', e);
      }
    };
    load();
  }, []);

  // Pipeline-Namen nachladen, falls nur IDs vorhanden
  useEffect(() => {
    const missing = new Set<string>();
    for (const e of entries) {
      if (e.pipelineId && !e.pipelineName && !pipelineNames[e.pipelineId]) {
        missing.add(e.pipelineId);
      }
    }
    if (missing.size === 0) return;

    (async () => {
      const updates: Record<string, string> = {};
      await Promise.all(
          Array.from(missing).map(async (id) => {
            const name = await fetchPipelineNameById(id);
            if (name) updates[id] = name;
          }),
      );
      if (Object.keys(updates).length) {
        setPipelineNames(prev => ({ ...prev, ...updates }));
      }
    })();
  }, [entries, pipelineNames]);

  // Live-Updates über WebSocket
  useEffect(() => {
    const socket = new WebSocket(WS_URL);
    socket.addEventListener('error', e => console.error('history ws', e));
    socket.addEventListener('message', ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'history' && Array.isArray(msg.data)) {
          const bulk = msg.data.map((e: any) => normalizeEntry(e));
          setEntries(prev => {
            const map = new Map<number, HistoryEntry>();
            [...prev, ...bulk].forEach(x => map.set(x.id, x));
            const merged = Array.from(map.values());
            merged.sort((a, b) => dayjs(b.timestamp).valueOf() - dayjs(a.timestamp).valueOf());
            return merged;
          });
        } else if (msg.type === 'update' && msg.data) {
          const one = normalizeEntry(msg.data);
          setEntries(prev => {
            const map = new Map<number, HistoryEntry>();
            prev.forEach(x => map.set(x.id, x));
            map.set(one.id, one);
            const merged = Array.from(map.values());
            merged.sort((a, b) => dayjs(b.timestamp).valueOf() - dayjs(a.timestamp).valueOf());
            return merged;
          });
          const pdfIdParam = new URLSearchParams(location.search).get('pdfId');
          if (pdfIdParam && String(one.pdfId) === pdfIdParam && !selected) {
            setSelected(one);
          }
        }
      } catch (e) {
        console.error('history ws parse', e);
      }
    });
    return () => socket.close();
  }, [selected]);

  const filtered = useMemo(() => {
    return entries.filter(e => {
      const ts = dayjs(e.timestamp);
      if (start && ts.isBefore(start, 'day')) return false;
      if (end && ts.isAfter(end, 'day')) return false;
      if (search) {
        const s = search.toLowerCase();
        const hay = [
          e.prompt?.toLowerCase() ?? '',
          JSON.stringify(e.result ?? {}).toLowerCase(),
          String(e.pdfId),
          e.pipelineName?.toLowerCase() ?? '',
        ].join(' ');
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [entries, start, end, search]);

  const groups = filtered.reduce<Record<string, HistoryEntry[]>>((acc, cur) => {
    const day = dayjs(cur.timestamp).format('YYYY-MM-DD');
    (acc[day] ||= []).push(cur);
    return acc;
  }, {});
  const groupKeys = Object.keys(groups).sort((a, b) => (a > b ? -1 : 1));

  const getPipelineLabel = (e: HistoryEntry) => {
    if (e.pipelineName) return e.pipelineName;
    if (e.pipelineId && pipelineNames[e.pipelineId]) return pipelineNames[e.pipelineId];
    // kein Fallback auf ID anzeigen
    return '—';
  };

  const cols: GridColDef<HistoryEntry>[] = [
    {
      field: 'timestamp',
      headerName: 'Zeit',
      flex: 0.6,
      valueGetter: p => dayjs(p.row.timestamp).format('HH:mm:ss'),
    },
    {
      field: 'pipeline',
      headerName: 'Pipeline',
      flex: 1.2,
      valueGetter: p => getPipelineLabel(p.row),
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 120,
      renderCell: params => (
          <Chip
              size="small"
              label={params.row.status || ''}
              color={params.row.status === 'completed' ? 'success' : params.row.status === 'running' ? 'warning' : 'default'}
              variant="outlined"
          />
      ),
    },
    {
      field: 'overall',
      headerName: 'Score',
      flex: 0.6,
      valueGetter: p => {
        const r = normalizeRun(p.row.result);
        return typeof r?.overall_score === 'number' ? r.overall_score.toFixed(2) : '—';
      },
    },
    {
      field: 'actions',
      headerName: '',
      sortable: false,
      width: 110, // verbreitert für 2 Icons
      renderCell: params => (
          <Stack direction="row" spacing={0.5}>
            <IconButton size="small" title="Details anzeigen" onClick={() => setSelected(params.row)}>
              <VisibilityIcon fontSize="small" />
            </IconButton>
            <IconButton
                size="small"
                title="In RunDetailsPage öffnen"
                onClick={() => void openRunDetailsPageInNewTab(params.row)}
            >
              <OpenInNewIcon fontSize="small" />
            </IconButton>
          </Stack>
      ),
    },
  ];

  return (
      <Box>
        <PageHeader title="History" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'History' }]} />

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <TextField label="Suche" size="small" value={search} onChange={e => setSearch(e.target.value)} />
          <DatePicker label="Start" value={start} onChange={d => setStart(d)} slotProps={{ textField: { size: 'small' } }} />
          <DatePicker label="Ende" value={end} onChange={d => setEnd(d)} slotProps={{ textField: { size: 'small' } }} />
        </Stack>

        {groupKeys.map(day => (
            <Box key={day} sx={{ mb: 3 }}>
              <Typography
                  variant="h6"
                  sx={{ position: 'sticky', top: 64, bgcolor: 'background.default', px: 1, py: 0.5, zIndex: 1 }}
              >
                {dayjs(day).format('LL')}
              </Typography>
              <Paper sx={{ mt: 1 }}>
                <DataGrid
                    autoHeight
                    disableRowSelectionOnClick
                    rows={groups[day]}
                    columns={cols}
                    pageSizeOptions={[5, 10, 25]}
                    initialState={{ pagination: { paginationModel: { pageSize: 5, page: 0 } } }}
                />
              </Paper>
            </Box>
        ))}

        <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)}>
          {selected && selected.result && (
              <Box sx={{ width: { xs: 320, sm: 440 }, p: 2 }}>
                {selected.prompt && (
                    <Typography variant="h6" gutterBottom>
                      {selected.prompt}
                    </Typography>
                )}
                <Typography variant="body2" gutterBottom>
                  {dayjs(selected.timestamp).format('LLL')}
                </Typography>
                <RunDetails run={normalizeRun(selected.result)} pdfUrl={selected.pdfUrl} />
              </Box>
          )}
        </Drawer>
      </Box>
  );
}
