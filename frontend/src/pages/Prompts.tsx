import React, { useEffect, useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Slider,
  Card,
  CardContent,
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
  json_key?: string;
  favorite: boolean;
  type: PromptType;
}

export default function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newText, setNewText] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [newJsonKey, setNewJsonKey] = useState('');
  const [newType, setNewType] = useState<PromptType>('ExtractionPrompt');

  useEffect(() => {
    if (newType === 'ExtractionPrompt') setNewWeight(1);
    else setNewJsonKey('');
  }, [newType]);

  const canCreate =
    newText.trim() !== '' &&
    (newType !== 'ExtractionPrompt' || newJsonKey.trim() !== '');

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
      body: JSON.stringify({
        text: newText,
        weight: newType === 'ExtractionPrompt' ? 1 : newWeight,
        json_key: newType === 'ExtractionPrompt' ? newJsonKey : undefined,
        type: newType,
      }),
    })
      .then(() => {
        setNewText('');
        setNewWeight(1);
        setNewJsonKey('');
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
        {newType === 'ExtractionPrompt' ? (
          <TextField
            label="JSON-Key"
            value={newJsonKey}
            onChange={e => setNewJsonKey(e.target.value)}
            sx={{ width: 180 }}
          />
        ) : (
          <Box sx={{ width: 180, display: 'flex', alignItems: 'center' }}>
            <Slider
              min={0}
              max={5}
              step={0.1}
              value={newWeight}
              onChange={(_, v) => setNewWeight(v as number)}
              sx={{ mr: 1, flexGrow: 1 }}
            />
            <TextField
              type="number"
              size="small"
              value={newWeight}
              onChange={e => setNewWeight(parseFloat(e.target.value))}
              inputProps={{ step: 1, min: 0, max: 10 }}
              sx={{ width: 130 }}
            />
          </Box>
        )}
        <Button
          variant="contained"
          color={canCreate ? 'primary' : 'inherit'}
          disabled={!canCreate}
          onClick={create}
        >
          Add
        </Button>
      </Box>
      {prompts.map(p => {
        const canSave =
          p.type !== 'ExtractionPrompt' || (p.json_key && p.json_key.trim().length > 0);
        return (
        <Card key={p.id} sx={{ mb: 1 }}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box sx={{ flexGrow: 1 }}>{p.text}</Box>
            <FormControl sx={{ minWidth: 160 }} size="small">
              <InputLabel>Typ</InputLabel>
              <Select
                label="Typ"
                value={p.type}
                onChange={e =>
                  setPrompts(ps =>
                    ps.map(it =>
                      it.id === p.id
                        ? {
                            ...it,
                            type: e.target.value as PromptType,
                            weight: e.target.value === 'ExtractionPrompt' ? 1 : it.weight,
                          }
                        : it
                    )
                  )
                }
              >
                <MenuItem value="ExtractionPrompt">ExtractionPrompt</MenuItem>
                <MenuItem value="ScoringPrompt">ScoringPrompt</MenuItem>
                <MenuItem value="DecisionPrompt">DecisionPrompt</MenuItem>
              </Select>
            </FormControl>
            {p.type === 'ExtractionPrompt' ? (
              <TextField
                label="JSON-Key"
                size="small"
                value={p.json_key || ''}
                onChange={e =>
                  setPrompts(ps =>
                    ps.map(it => (it.id === p.id ? { ...it, json_key: e.target.value } : it))
                  )
                }
                sx={{ width: 180 }}
              />
            ) : (
              <Box sx={{ width: 180, display: 'flex', alignItems: 'center' }}>
                <Slider
                  min={0}
                  max={5}
                  step={0.1}
                  value={p.weight}
                  onChange={(_, v) =>
                    setPrompts(ps =>
                      ps.map(it => (it.id === p.id ? { ...it, weight: v as number } : it))
                    )
                  }
                  sx={{ mr: 1, flexGrow: 1 }}
                />
                <TextField
                  type="number"
                  size="small"
                  value={p.weight}
                  onChange={e =>
                    setPrompts(ps =>
                      ps.map(it =>
                        it.id === p.id ? { ...it, weight: parseFloat(e.target.value) } : it
                      )
                    )
                  }
                  inputProps={{ step: 1, min: 0, max: 10 }}
                  sx={{ width: 130 }}
                />
              </Box>
            )}
            <Button
              variant="outlined"
              size="small"
              disabled={!canSave}
              onClick={() => {
                if (p.type === 'ExtractionPrompt' && !p.json_key?.trim()) return;
                fetch(`http://localhost:8082/prompts/${p.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    text: p.text,
                    weight: p.type === 'ExtractionPrompt' ? 1 : p.weight,
                    json_key: p.type === 'ExtractionPrompt' ? p.json_key : undefined,
                    type: p.type,
                    favorite: p.favorite,
                  }),
                }).then(load);
              }}
            >
              Save
            </Button>
            <Button size="small" onClick={() => del(p.id)}>
              <DeleteIcon />
            </Button>
          </CardContent>
        </Card>
        );
      })}
    </Box>
  );
}
