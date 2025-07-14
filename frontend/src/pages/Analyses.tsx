import React, { useEffect, useState, useMemo } from 'react';
import {
  Box,
  Tabs,
  Tab,
  Paper,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  LinearProgress,
  Grid,
  Card,
  CardContent,
} from '@mui/material';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import PageHeader from '../components/PageHeader';

interface Entry {
  id: number; // analysis id
  pdfId: number;
  prompt?: string;
  status: string;
}

interface Rule {
  prompt: string;
  weight: number;
  result: boolean;
  answer: string;
  source: string;
}

interface ResponseItem {
  answer: string;
  source: string;
}

interface DashboardData {
  score: number;
  resultLabel: 'KEIN_REGRESS' | 'MÖGLICHER_REGRESS' | 'SICHER_REGRESS';
  rules: Rule[];
  responses: ResponseItem[];
}

export default function Analyses() {
  const [tab, setTab] = useState(0);
  const [running, setRunning] = useState<Entry[]>([]);
  const [done, setDone] = useState<Entry[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardId, setDashboardId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);

  const load = () => {
    Promise.all([
      fetch('http://localhost:8090/analyses?status=running').then(r => r.json()),
      fetch('http://localhost:8090/analyses?status=completed').then(r => r.json()),
    ])
      .then(([runningData, doneData]: [any[], any[]]) => {
        const map = (d: any): Entry => ({
          id: d.id,
          pdfId: d.pdf_id ?? d.pdfId,
          prompt: d.prompt,
          status: d.status,
        });
        setRunning(runningData.map(map));
        setDone(doneData.map(map));
      })
      .catch(e => console.error('load analyses', e));
  };

  useEffect(load, []);

  const openDashboard = (pdfId: number) => {
    const backend = import.meta.env.VITE_CLASSIFIER_URL || 'http://localhost:8084';
    fetch(`${backend}/results/${pdfId}`)
      .then(r => r.json())
      .then(d => {
        setDashboardId(pdfId.toString());
        setDashboard({
          score: d.score,
          resultLabel: d.result_label,
          rules: (d.metrics.rules || []).map((r: any) => ({
            prompt: r.prompt,
            weight: r.weight,
            result: r.result,
            answer: r.answer || '',
            source: r.source || '',
          })),
          responses: (d.responses || []).map((r: any) => ({
            answer: r.answer,
            source: r.source || '',
          })),
        });
      })
      .catch(e => console.error('load result', e));
  };

  const closeDashboard = () => {
    setDashboard(null);
    setQuery('');
    setOnlyFailed(false);
  };

  const keyword = query.toLowerCase();
  const rules = useMemo(() => {
    if (!dashboard) return [] as Rule[];
    return dashboard.rules.filter(r => {
      if (onlyFailed && r.result) return false;
      return (
        r.prompt.toLowerCase().includes(keyword) ||
        r.answer.toLowerCase().includes(keyword)
      );
    });
  }, [dashboard, keyword, onlyFailed]);

  const responses = useMemo(() => {
    if (!dashboard) return [] as ResponseItem[];
    return dashboard.responses.filter(r =>
      `${r.answer} ${r.source}`.toLowerCase().includes(keyword)
    );
  }, [dashboard, keyword]);

const renderList = (items: Entry[], finished: boolean) => (
  <Paper sx={{ p: 2 }}>
    {items.map(e => (
      <Box key={e.id} sx={{ mb: 1, display: 'flex', justifyContent: 'space-between' }}>
        <Typography>{e.pdfId} - {e.prompt || 'Prompt'}</Typography>
        {finished && (
          <Button size="small" onClick={() => openDashboard(e.pdfId)}>
            Ergebnis anzeigen
          </Button>
        )}
      </Box>
    ))}
    {items.length === 0 && <Typography>Keine Einträge</Typography>}
  </Paper>
  );

  return (
    <Box>
      <PageHeader title="Analysen" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Analysen' }]} actions={<Button variant="contained" onClick={load}>Reload</Button>} />
      <Tabs value={tab} onChange={(_,v)=>setTab(v)} sx={{ mb:2 }}>
        <Tab label={`Laufend (${running.length})`} />
        <Tab label={`Abgeschlossen (${done.length})`} />
      </Tabs>
      {tab === 0 ? renderList(running, false) : renderList(done, true)}
      {dashboard && (
        <Dialog open onClose={closeDashboard} maxWidth="md" fullWidth>
          <DialogTitle>Dokument ID: {dashboardId}</DialogTitle>
          <DialogContent dividers>
            {(() => {
              const color =
                dashboard.resultLabel === 'SICHER_REGRESS'
                  ? 'success.main'
                  : dashboard.resultLabel === 'MÖGLICHER_REGRESS'
                  ? 'warning.main'
                  : 'error.main';
              return (
                <Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <Box sx={{ width: 16, height: 16, borderRadius: '50%', bgcolor: color }} />
                    <Typography>{dashboard.resultLabel}</Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={dashboard.score * 100}
                    sx={{ mb: 2, height: 8, borderRadius: 1 }}
                  />
                  <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 2 }}>
                    <TextField
                      label="Suche"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      size="small"
                      sx={{ flexGrow: 1, minWidth: 160 }}
                    />
                    <FormControl size="small" sx={{ minWidth: 120 }}>
                      <InputLabel id="filter-label">Regeln</InputLabel>
                      <Select
                        labelId="filter-label"
                        value={onlyFailed ? 'fails' : 'all'}
                        label="Regeln"
                        onChange={e => setOnlyFailed(e.target.value === 'fails')}
                      >
                        <MenuItem value="all">Alle Regeln</MenuItem>
                        <MenuItem value="fails">Nur Fehler</MenuItem>
                      </Select>
                    </FormControl>
                  </Box>
                  <Grid container spacing={2}>
                    <Grid item xs={12} md={6}>
                      <Box sx={{ height: 288 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={rules} layout="vertical">
                            <XAxis type="number" />
                            <YAxis
                              type="category"
                              dataKey="prompt"
                              tickFormatter={v => (v.length > 20 ? `${v.slice(0, 20)}…` : v)}
                              width={150}
                            />
                            <Tooltip
                              content={({ active, payload }: any) => {
                                if (!active || !payload?.length) return null;
                                const r: Rule = payload[0].payload;
                                return (
                                  <Paper sx={{ p: 1 }}>
                                    <Typography variant="subtitle2" sx={{ wordBreak: 'break-word' }}>
                                      {r.prompt}
                                    </Typography>
                                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                                      {r.answer}
                                    </Typography>
                                    {r.source && (
                                      <Typography
                                        component="code"
                                        variant="caption"
                                        sx={{ display: 'block', whiteSpace: 'pre-wrap', mt: 0.5 }}
                                      >
                                        {r.source}
                                      </Typography>
                                    )}
                                  </Paper>
                                );
                              }}
                            />
                            <Bar dataKey="weight">
                              {rules.map((r, i) => (
                                <Cell key={i} fill={r.result ? '#2e7d32' : '#d32f2f'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </Box>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Box sx={{ maxHeight: 288, overflowY: 'auto' }}>
                        {responses.map((r, i) => (
                          <Card key={i} sx={{ mb: 1 }}>
                            <CardContent>
                              <Typography sx={{ whiteSpace: 'pre-wrap' }}>{r.answer}</Typography>
                              {r.source && (
                                <Typography
                                  component="code"
                                  variant="caption"
                                  sx={{ display: 'block', whiteSpace: 'pre-wrap', mt: 0.5 }}
                                >
                                  {r.source}
                                </Typography>
                              )}
                            </CardContent>
                          </Card>
                        ))}
                      </Box>
                    </Grid>
                  </Grid>
                </Box>
              );
            })()}
          </DialogContent>
          <DialogActions>
            <Button onClick={closeDashboard}>Schließen</Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
