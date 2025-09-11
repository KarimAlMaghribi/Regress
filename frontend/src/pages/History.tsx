import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Paper, Typography, IconButton, Drawer, Stack, TextField, Chip,
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import PageHeader from '../components/PageHeader';
import VisibilityIcon from '@mui/icons-material/Visibility';
import dayjs, { Dayjs } from 'dayjs';
import { PipelineRunResult } from '../types/pipeline';
import RunDetails from '../components/RunDetails';
import { FinalSnapshotCell } from '../components/final/FinalPills';

declare global {
  interface Window { __ENV__?: any }
}

const RUNTIME = (window as any).__ENV__ || {};
const BASE_HIST = RUNTIME.HISTORY_URL || import.meta.env.VITE_HISTORY_URL || '/hist';
const WS_URL =
    RUNTIME.HISTORY_WS ||
    import.meta.env.VITE_HISTORY_WS ||
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/histws`;

interface HistoryEntry {
  id: number; // unique analysis id
  pdfId: number;
  timestamp: string;
  result?: PipelineRunResult | null;
  pdfUrl: string;
  prompt?: string | null;
  status?: string;
}

function normalizeEntry(e: any): HistoryEntry {
  return {
    id: e.id ?? Date.now() + Math.random(),
    pdfId: e.pdf_id ?? e.pdfId ?? e.pdfId,
    pdfUrl: e.pdfUrl ?? e.pdf_url,
    timestamp: e.timestamp,
    result: e.result ?? undefined,
    prompt: e.prompt ?? null,
    status: e.status,
  };
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [search, setSearch] = useState('');
  const [start, setStart] = useState<Dayjs | null>(null);
  const [end, setEnd] = useState<Dayjs | null>(null);

  // --- Initial REST Load (running + completed) ---
  useEffect(() => {
    const load = async () => {
      try {
        const [rRunning, rCompleted] = await Promise.all([
          fetch(`${BASE_HIST}/analyses?status=running`).then(r => r.json()),
          fetch(`${BASE_HIST}/analyses?status=completed`).then(r => r.json()),
        ]);
        const initial = [...rRunning, ...rCompleted].map(normalizeEntry);
        // newest first
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

  // --- Live-Updates über WebSocket (weiterhin aktiv) ---
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
          // Falls der Update-Eintrag dem pdfId-Param entspricht und wir noch nichts selektiert haben
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

  const cols: GridColDef<HistoryEntry>[] = [
    {
      field: 'timestamp',
      headerName: 'Zeit',
      flex: 0.6,
      valueGetter: p => dayjs(p.row.timestamp).format('HH:mm:ss'),
    },
    {
      field: 'prompt',
      headerName: 'Prompt',
      flex: 1.2,
      renderCell: params => (
          <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
            {params.row.prompt && (
                <Chip label={params.row.prompt} size="small" sx={{ mr: 0.5, mb: 0.5 }} />
            )}
          </Box>
      ),
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
      valueGetter: p => p.row.result?.overallScore?.toFixed(2) ?? '—',
    },
    {
      field: 'route',
      headerName: 'Route',
      flex: 1.2,
      valueGetter: p => p.row.result?.log?.map((l: any) => l.route ?? 'root').join(' › ') || '',
    },
    {
      field: 'final',
      headerName: 'Final',
      flex: 1.6,
      sortable: false,
      renderCell: params => <FinalSnapshotCell result={params.row.result} />,
    },
    {
      field: 'actions',
      headerName: '',
      sortable: false,
      width: 60,
      renderCell: params => (
          <IconButton size="small" onClick={() => setSelected(params.row)}>
            <VisibilityIcon fontSize="small" />
          </IconButton>
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
                <RunDetails run={selected.result} pdfUrl={selected.pdfUrl} />
              </Box>
          )}
        </Drawer>
      </Box>
  );
}
