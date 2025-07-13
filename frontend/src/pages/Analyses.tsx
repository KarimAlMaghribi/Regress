import React, { useEffect, useState } from 'react';
import { Box, Tabs, Tab, Paper, Button, Typography } from '@mui/material';
import PageHeader from '../components/PageHeader';

interface Entry {
  id: number; // analysis id
  pdfId: number;
  prompt?: string;
  status: string;
}

export default function Analyses() {
  const [tab, setTab] = useState(0);
  const [running, setRunning] = useState<Entry[]>([]);
  const [done, setDone] = useState<Entry[]>([]);

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

const renderList = (items: Entry[], finished: boolean) => (
  <Paper sx={{ p: 2 }}>
    {items.map(e => (
      <Box key={e.id} sx={{ mb: 1, display: 'flex', justifyContent: 'space-between' }}>
        <Typography>{e.pdfId} - {e.prompt || 'Prompt'}</Typography>
        {finished && (
          <Button size="small" href={`/result/${e.pdfId}`} target="_blank" rel="noopener">Ergebnis anzeigen</Button>
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
    </Box>
  );
}
