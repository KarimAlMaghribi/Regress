import React, { useEffect, useState, useMemo } from 'react';
import { Box, Tabs, Tab, Paper, Button, Typography } from '@mui/material';
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={closeDashboard}>
          <div
            className="bg-white p-4 rounded shadow max-h-screen overflow-y-auto w-full max-w-2xl"
            onClick={e => e.stopPropagation()}
          >
            <button className="mb-2 px-2 py-1 border rounded" onClick={closeDashboard}>Schließen</button>
            <div className="space-y-4">
              <h2 className="text-xl font-bold">Dokument ID: {dashboardId}</h2>
              <div className="flex items-center gap-2">
                <div
                  className={`w-4 h-4 rounded-full ${
                    dashboard.resultLabel === 'SICHER_REGRESS'
                      ? 'bg-green-500'
                      : dashboard.resultLabel === 'MÖGLICHER_REGRESS'
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                />
                <span>{dashboard.resultLabel}</span>
              </div>
              <progress value={dashboard.score} max={1} className="w-full h-2 accent-blue-500"></progress>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Suche"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="p-2 border rounded w-full"
                />
                <select
                  value={onlyFailed ? 'fails' : 'all'}
                  onChange={e => setOnlyFailed(e.target.value === 'fails')}
                  className="p-2 border rounded"
                >
                  <option value="all">Alle Regeln</option>
                  <option value="fails">Nur Fehler</option>
                </select>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="h-72">
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
                            <div className="p-2 bg-white border rounded shadow text-sm">
                              <p className="font-semibold break-words">{r.prompt}</p>
                              <p className="whitespace-pre-wrap">{r.answer}</p>
                              {r.source && (
                                <code className="block mt-1 whitespace-pre-wrap">{r.source}</code>
                              )}
                            </div>
                          );
                        }}
                      />
                      <Bar dataKey="weight">
                        {rules.map((r, i) => (
                          <Cell key={i} fill={r.result ? '#22c55e' : '#ef4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-y-auto max-h-72">
                  {responses.map((r, i) => (
                    <div key={i} className="p-4 border rounded-lg mb-2">
                      <p className="whitespace-pre-wrap">{r.answer}</p>
                      {r.source && (
                        <code className="block mt-1 whitespace-pre-wrap">{r.source}</code>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Box>
  );
}
