import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Paper,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Snackbar,
  Alert,
  Grid,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  Tabs,
  Tab,
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import useAnalysisHistory, { AnalysisResult } from '../hooks/useAnalysisHistory';
import PageHeader from '../components/PageHeader';

export default function AnalysisHistory() {
  const [promptId, setPromptId] = useState('');
  const [prompts, setPrompts] = useState<{ id: string; name: string }[]>([]);
  const [start, setStart] = useState<Date | null>(null);
  const [end, setEnd] = useState<Date | null>(null);
  const [options, setOptions] = useState({});
  const { data, loading, error } = useAnalysisHistory({
    ...(options as any),
    limit: 50,
  });
  const [snackOpen, setSnackOpen] = useState(false);
  const [selected, setSelected] = useState<AnalysisResult | null>(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    fetch(`${import.meta.env.REACT_APP_API_URL || ''}/api/prompts`)
      .then(r => r.json())
      .then(d => setPrompts(d))
      .catch(e => console.error('load prompts', e));
  }, []);

  useEffect(() => {
    if (error) setSnackOpen(true);
  }, [error]);

  const handleFilter = () => {
    setOptions({
      promptId: promptId || undefined,
      start: start || undefined,
      end: end || undefined,
    });
  };

  const columns: GridColDef[] = [
    {
      field: 'runTime',
      headerName: 'Run Time',
      flex: 1,
      valueGetter: p => new Date(p.row.runTime).toLocaleString(),
    },
    {
      field: 'prompt',
      headerName: 'Prompt',
      flex: 1,
      valueGetter: p => p.row.promptName || p.row.promptId,
    },
    {
      field: 'pdfCount',
      headerName: 'PDFs',
      type: 'number',
      flex: 0.5,
      valueGetter: p => p.row.pdfFilenames.length,
    },
    {
      field: 'accuracy',
      headerName: 'Accuracy',
      flex: 0.5,
      valueGetter: p => `${(p.row.metrics.accuracy * 100).toFixed(1)}%`,
    },
    {
      field: 'cost',
      headerName: 'Cost',
      flex: 0.5,
      valueGetter: p => `€${p.row.metrics.cost.toFixed(4)}`,
    },
    {
      field: 'actions',
      headerName: 'Actions',
      sortable: false,
      flex: 0.5,
      renderCell: params => (
        <Button size="small" onClick={() => setSelected(params.row)}>
          Details
        </Button>
      ),
    },
  ];

  return (
    <Box>
      <PageHeader
        title="Analysis History"
        breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'History' }]}
      />
      <Paper sx={{ mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel id="prompt-label">Prompt</InputLabel>
              <Select
                labelId="prompt-label"
                value={promptId}
                label="Prompt"
                onChange={e => setPromptId(e.target.value)}
              >
                <MenuItem value="">
                  <em>All</em>
                </MenuItem>
                {prompts.map(p => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item>
            <DatePicker
              label="Start"
              value={start}
              onChange={d => setStart(d ? new Date(d.toString()) : null)}
              slotProps={{ textField: { size: 'small' } }}
            />
          </Grid>
          <Grid item>
            <DatePicker
              label="End"
              value={end}
              onChange={d => setEnd(d ? new Date(d.toString()) : null)}
              slotProps={{ textField: { size: 'small' } }}
            />
          </Grid>
          <Grid item>
            <Button variant="contained" onClick={handleFilter}>
              Filter
            </Button>
          </Grid>
        </Grid>
      </Paper>
      <Paper>
        <DataGrid
          autoHeight
          columns={columns}
          rows={data}
          pageSizeOptions={[10, 25, 50]}
          initialState={{ pagination: { paginationModel: { pageSize: 10, page: 0 } } }}
          loading={loading}
        />
        {!loading && data.length === 0 && (
          <Typography sx={{ p: 2 }} align="center">
            Keine Einträge gefunden
          </Typography>
        )}
      </Paper>

      <Dialog
        open={!!selected}
        onClose={() => setSelected(null)}
        fullWidth
        maxWidth="md"
      >
        <DialogTitle>Details</DialogTitle>
        {selected && (
          <DialogContent dividers>
            <Typography variant="subtitle2">Prompt</Typography>
            <Typography gutterBottom>
              {selected.promptName || selected.promptId}
            </Typography>
            <Typography variant="subtitle2">Timestamp</Typography>
            <Typography gutterBottom>
              {new Date(selected.runTime).toLocaleString()}
            </Typography>
            <Typography variant="subtitle2">PDFs</Typography>
            <Typography gutterBottom>
              {selected.pdfFilenames.join(', ')}
            </Typography>
            <Grid container spacing={2} sx={{ my: 1 }}>
              <Grid item xs={12} sm={4}>
                <Paper sx={{ p: 1, textAlign: 'center' }}>
                  <Typography variant="subtitle2">Accuracy</Typography>
                  <Typography>
                    {(selected.metrics.accuracy * 100).toFixed(1)}%
                  </Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Paper sx={{ p: 1, textAlign: 'center' }}>
                  <Typography variant="subtitle2">Cost</Typography>
                  <Typography>
                    €{selected.metrics.cost.toFixed(4)}
                  </Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Paper sx={{ p: 1, textAlign: 'center' }}>
                  <Typography variant="subtitle2">Hallucination</Typography>
                  <Typography>
                    {(selected.metrics.hallucinationRate * 100).toFixed(1)}%
                  </Typography>
                </Paper>
              </Grid>
            </Grid>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1 }}>
              <Tab label="Responses" />
              <Tab label="Metrics" />
            </Tabs>
            {tab === 0 && (
              <Box>
                {selected.responses?.map((r, i) => (
                  <Paper key={i} sx={{ p: 1, mb: 1 }}>
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                      {r.answer}
                    </Typography>
                    {r.source && (
                      <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap', display:'block' }}>
                        Source: {r.source}
                      </Typography>
                    )}
                  </Paper>
                )) || (
                  <Typography variant="body2">No responses</Typography>
                )}
              </Box>
            )}
            {tab === 1 && (
              <Box component="pre" sx={{ whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(selected.metrics, null, 2)}
              </Box>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
              <Button onClick={() => setSelected(null)}>Schließen</Button>
            </Box>
          </DialogContent>
        )}
      </Dialog>

      <Snackbar
        open={snackOpen}
        autoHideDuration={6000}
        onClose={() => setSnackOpen(false)}
      >
        <Alert onClose={() => setSnackOpen(false)} severity="error">
          {error}
        </Alert>
      </Snackbar>
    </Box>
  );
}
