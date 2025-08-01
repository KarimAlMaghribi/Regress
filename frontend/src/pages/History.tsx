import React, { useEffect, useState } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Drawer,
  Stack,
  TextField,
  Chip,
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import PageHeader from '../components/PageHeader';
import VisibilityIcon from '@mui/icons-material/Visibility';
import dayjs, { Dayjs } from 'dayjs';
import { useTheme } from '@mui/material/styles';
import { PipelineRunResult, PromptResult, ScoringResult } from '../types/pipeline';

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
  const theme = useTheme();

  useEffect(() => {
    const url = import.meta.env.VITE_HISTORY_WS || 'ws://localhost:8090';
    const socket = new WebSocket(url);
    socket.addEventListener('error', e => {
      console.error('history ws', e);
    });
    socket.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'history') {
        setEntries(msg.data.map((e: any) => normalizeEntry(e)));
      } else if (msg.type === 'update') {
        setEntries(e => [normalizeEntry(msg.data), ...e]);
      }
    });
    return () => socket.close();
  }, []);


  const filtered = entries.filter(e => {
    const ts = dayjs(e.timestamp);
    if (start && ts.isBefore(start, 'day')) return false;
    if (end && ts.isAfter(end, 'day')) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!(e.prompt?.toLowerCase().includes(s) || JSON.stringify(e.result).toLowerCase().includes(s))) {
        return false;
      }
    }
    return true;
  });

  const groups = filtered.reduce<Record<string, HistoryEntry[]>>((acc, cur) => {
    const day = dayjs(cur.timestamp).format('YYYY-MM-DD');
    acc[day] = acc[day] || [];
    acc[day].push(cur);
    return acc;
  }, {});
  const groupKeys = Object.keys(groups).sort((a, b) => (a > b ? -1 : 1));

  const pctFmt = new Intl.NumberFormat('de-DE', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const baseCols: GridColDef[] = [
    {
      field: 'timestamp',
      headerName: 'Zeit',
      flex: 1,
      valueGetter: p => dayjs(p.row.timestamp).format('HH:mm:ss'),
    },
    {
      field: 'prompt',
      headerName: 'Prompt',
      flex: 1,
      renderCell: params => (
        <Box sx={{ display: 'flex', flexWrap: 'wrap' }}>
          {params.row.prompt && (
            <Chip label={params.row.prompt} size="small" sx={{ mr: 0.5, mb: 0.5 }} />
          )}
        </Box>
      ),
    },
    { field: 'status', headerName: 'Status', width: 110, valueGetter: p => p.row.status || '' },
    {
      field: 'overall',
      headerName: 'Score',
      flex: 0.8,
      valueGetter: p => p.row.result?.overallScore?.toFixed(2) ?? '—',
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
              columns={baseCols}
              pageSizeOptions={[5, 10, 25]}
              initialState={{ pagination: { paginationModel: { pageSize: 5, page: 0 } } }}
            />
          </Paper>
        </Box>
      ))}

      <Drawer anchor="right" open={!!selected} onClose={() => setSelected(null)}>
        {selected && (
          <Box sx={{ width: { xs: 280, sm: 400 }, p: 2 }}>
            <Typography variant="h6" gutterBottom>
              {selected.prompt || 'Eintrag'}
            </Typography>
            <Typography variant="body2" gutterBottom>
              {dayjs(selected.timestamp).format('LLL')}
            </Typography>
            <Typography variant="body2" gutterBottom>
              Score: {selected.result?.overallScore?.toFixed(2)}
            </Typography>
            {(['extraction','scoring','decision'] as const).map(cat => (
              <Box key={cat} sx={{ mb: 1 }}>
                <Typography variant="subtitle2" gutterBottom>{cat}</Typography>
                <PromptDetailsTable data={selected.result ? (selected.result as any)[cat] : []} />
              </Box>
            ))}

          <iframe src={selected.pdfUrl} width="100%" height="400" title="pdf" />
          </Box>
        )}
      </Drawer>
    </Box>
  );
}

function PromptDetailsTable({ data }: { data: any[] }) {
  return (
    <table className="prompt-table" style={{ fontSize: '0.8rem' }}>
      <thead>
        <tr>
          <th>ID</th>
          <th>Prompt</th>
          <th>Quote</th>
          <th>Score/Bool</th>
          <th>Route</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        {data.map(p => (
          <tr key={p.promptId}>
            <td>{p.promptId}</td>
            <td title={p.promptText}>{p.promptText.slice(0, 40)}…</td>
            <td>{p.source?.quote ?? '—'}</td>
            <td>{(p as any).score ?? String((p as any).boolean ?? (p as any).result ?? '')}</td>
            <td>{p.route ?? '—'}</td>
            <td>
              {p.source
                ? `p${p.source.page} [${p.source.bbox.join(',')}]`
                : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
