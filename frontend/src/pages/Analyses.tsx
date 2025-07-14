import React, { useEffect, useState } from 'react';
import { Box, Tabs, Tab, Paper, Button, Typography, Table, TableHead, TableRow, TableCell, TableBody, Chip } from '@mui/material';
import PageHeader from '../components/PageHeader';

interface PromptCfg { text: string }

interface Entry {
  id: number; // analysis id
  pdfId: number;
  pdfUrl?: string;
  prompts: PromptCfg[];
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
        const map = (d: any): Entry => {
          let prompts: PromptCfg[] = [];
          try {
            const arr = JSON.parse(d.prompt ?? '');
            if (Array.isArray(arr)) {
              prompts = arr.map((p: any) => ({ text: p.text ?? String(p) }));
            } else if (typeof arr === 'string') {
              prompts = [{ text: arr }];
            }
          } catch {
            if (d.prompt) prompts = [{ text: d.prompt }];
          }
          return {
            id: d.id,
            pdfId: d.pdf_id ?? d.pdfId,
            pdfUrl: d.pdf_url ?? d.pdfUrl,
            prompts,
            status: d.status,
          } as Entry;
        };
        setRunning(runningData.map(map));
        setDone(doneData.map(map));
      })
      .catch(e => console.error('load analyses', e));
  };

  useEffect(load, []);

const renderList = (items: Entry[], finished: boolean) => (
  <Paper sx={{ p: 2 }}>
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Name der PDF</TableCell>
          <TableCell>Prompts</TableCell>
          {finished && <TableCell align="right">Ergebnis</TableCell>}
        </TableRow>
      </TableHead>
      <TableBody>
        {items.map(e => (
          <TableRow key={e.id}>
            <TableCell>{`PDF ${e.pdfId}`}</TableCell>
            <TableCell>
              {e.prompts.map((p, i) => (
                <Chip key={i} label={p.text} size="small" sx={{ mr: 0.5, mb: 0.5 }} />
              ))}
            </TableCell>
            {finished && (
              <TableCell align="right">
                <Button
                  size="small"
                  href={`/result/${e.pdfId}`}
                  target="_blank"
                  rel="noopener"
                  variant="outlined"
                >
                  Ergebnis anzeigen
                </Button>
              </TableCell>
            )}
          </TableRow>
        ))}
        {items.length === 0 && (
          <TableRow>
            <TableCell colSpan={finished ? 3 : 2} align="center">
              <Typography>Keine Einträge</Typography>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
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
