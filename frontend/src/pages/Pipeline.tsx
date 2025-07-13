import React, { useEffect, useState } from 'react';
import {
  Box, Paper, Typography, Checkbox, FormControlLabel, Button,
  FormControl, InputLabel, Select, MenuItem, Snackbar, Alert, Chip,
  ListItemText
} from '@mui/material';
import PageHeader from '../components/PageHeader';

interface Prompt { id: number; text: string; weight: number }
interface TextEntry { id: number }
interface Rule { prompt: string; weight: number; result: boolean }
interface AnalysisData {
  score: number;
  result_label: string;
  metrics: { rules?: Rule[] };
  [k: string]: any;
}

export default function Pipeline() {
  const [pdfs, setPdfs] = useState<TextEntry[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [promptIds, setPromptIds] = useState<number[]>([]);
  const [snack, setSnack] = useState('');
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);

  const load = () => {
    fetch('http://localhost:8083/texts')
      .then(r => r.json())
      .then(setPdfs)
      .catch(e => setSnack(`Fehler: ${e}`));
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then((d: any[]) => setPrompts(d.map(p => ({ ...p, weight: p.weight ?? 1 }))))
      .catch(e => setSnack(`Fehler: ${e}`));
  };

  useEffect(load, []);

  const toggle = (id: number, checked: boolean) => {
    setSelected(s => checked ? [...s, id] : s.filter(i => i !== id));
  };

  const start = () => {
    const chosen = promptIds.map(id => prompts.find(p => p.id === id)).filter(Boolean) as Prompt[];
    if (chosen.length === 0 || selected.length === 0) return;
    const payloadPrompts = chosen.map(p => ({ text: p.text, weight: p.weight }));
    const prompt = JSON.stringify(payloadPrompts);
    fetch('http://localhost:8083/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selected, prompt })
    }).then(() => {
      setSnack('Analyse gestartet');
      setSelected([]);
      const id = selected[0];
      if (id) {
        fetch(`http://localhost:8084/results/${id}`)
          .then(async r => {
            if (r.status === 202) {
              throw new Error('Analyse läuft noch');
            }
            return r.json();
          })
          .then(setAnalysis)
          .catch(e => setSnack(`Fehler: ${e}`));
      }
    }).catch(e => setSnack(`Fehler: ${e}`));
  };

  return (
    <Box>
      <PageHeader title="Pipeline" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline' }]} />
      <Paper sx={{ p:2, mb:2 }}>
        <Typography variant="subtitle1" gutterBottom>PDFs</Typography>
        {pdfs.map(p => (
          <FormControlLabel key={p.id} control={<Checkbox checked={selected.includes(p.id)} onChange={e => toggle(p.id, e.target.checked)} />} label={`PDF ${p.id}`} />
        ))}
        {pdfs.length === 0 && <Typography>Keine PDFs vorhanden</Typography>}
      </Paper>
      <FormControl size="small" sx={{ minWidth: 220, mb:2 }}>
        <InputLabel id="prompt-label">Prompts</InputLabel>
        <Select
          labelId="prompt-label"
          multiple
          value={promptIds}
          onChange={e => setPromptIds(typeof e.target.value === 'string' ? e.target.value.split(',').map(Number) : e.target.value as number[])}
          renderValue={sel => (sel as number[]).map(id => prompts.find(p => p.id === id)?.text).join(', ')}
        >
          {prompts.map(p => (
            <MenuItem key={p.id} value={p.id}>
              <Checkbox checked={promptIds.indexOf(p.id) > -1} />
              <ListItemText primary={`${p.text} (${p.weight ?? 1})`} />
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <Button variant="contained" disabled={!selected.length || promptIds.length===0} onClick={start}>Analyse starten</Button>
      {analysis && (
        <Paper sx={{ p:2, mt:2 }}>
          <Typography variant="h6" gutterBottom>
            Score: {analysis.score.toFixed(3)}
          </Typography>
          <Chip label={analysis.result_label} color="primary" sx={{ mb:2 }} />
          {analysis.metrics?.rules?.map((r,i)=>(
            <Typography key={i} variant="body2">
              {r.prompt}: {r.result ? 'true' : 'false'} (w={r.weight})
            </Typography>
          ))}
        </Paper>
      )}
      <Snackbar open={!!snack} autoHideDuration={4000} onClose={() => setSnack('')}>
        <Alert onClose={() => setSnack('')} severity="info">{snack}</Alert>
      </Snackbar>
    </Box>
  );
}
