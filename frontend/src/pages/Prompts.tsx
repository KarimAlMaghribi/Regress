import React, { useEffect, useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Slider,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import PageHeader from '../components/PageHeader';

type PromptType = 'ExtractionPrompt' | 'ScoringPrompt' | 'DecisionPrompt';
interface Prompt {
  id: number;
  text: string;
  weight: number;
  favorite: boolean;
  type: PromptType;
}

export default function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newText, setNewText] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [newType, setNewType] = useState<PromptType>('ExtractionPrompt');

  const load = () => {
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then(setPrompts)
      .catch(e => console.error('load prompts', e));
  };

  useEffect(load, []);

  const create = () => {
    fetch('http://localhost:8082/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: newText, weight: newWeight, type: newType }),
    })
      .then(() => {
        setNewText('');
        setNewWeight(1);
        load();
      })
      .catch(e => console.error('create prompt', e));
  };

  const del = (id: number) => {
    fetch(`http://localhost:8082/prompts/${id}`, { method: 'DELETE' })
      .then(load)
      .catch(e => console.error('delete prompt', e));
  };

  return (
    <Box>
      <PageHeader title="Prompts" />
      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <TextField value={newText} onChange={e => setNewText(e.target.value)} label="Text" fullWidth />
        <FormControl sx={{ minWidth: 160 }}>
          <InputLabel>Typ</InputLabel>
          <Select label="Typ" value={newType} onChange={e => setNewType(e.target.value as PromptType)}>
            <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
            <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
            <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
          </Select>
        </FormControl>
        <Box sx={{ width: 120 }}>
          <Slider min={0} max={5} step={0.1} value={newWeight} onChange={(_,v)=>setNewWeight(v as number)} />
        </Box>
        <Button variant="contained" onClick={create}>Add</Button>
      </Box>
      {prompts.map(p => (
        <Card key={p.id} sx={{ mb:1 }}>
          <CardContent>
            {p.text} ({p.type}) <Button onClick={()=>del(p.id)}><DeleteIcon/></Button>
          </CardContent>
        </Card>
      ))}
    </Box>
  );
}
