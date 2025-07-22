import React, { useEffect, useState } from 'react';
import {
  Paper,
  Box,
  TextField,
  Button,
  Select,
  MenuItem,
  SelectChangeEvent,
  FormControl,
  InputLabel,
} from '@mui/material';
import { Node } from 'reactflow';

interface Props {
  node: Node;
  onSave: (
    id: string,
    data: {
      label?: string;
      weight?: number;
      confidenceThreshold?: number;
      text?: string;
      promptId?: string | number;
    },
  ) => void;
}

export default function NodeEditPanel({ node, onSave }: Props) {
  const [label, setLabel] = useState((node.data as any)?.label || '');
  const [text, setText] = useState((node.data as any)?.text || '');
  const [weight, setWeight] = useState<string | number>((node.data as any)?.weight ?? '');
  const [threshold, setThreshold] = useState<string | number>(
    (node.data as any)?.confidenceThreshold ?? '',
  );
  const [prompts, setPrompts] = useState<{ id: number; text: string; weight: number }[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<string | ''>(
    String((node.data as any)?.promptId || ''),
  );

  useEffect(() => {
    fetch('/prompts')
      .then(r => r.json())
      .then((list: any[]) => setPrompts(list))
      .catch(e => console.error('load prompts', e));
  }, []);

  useEffect(() => {
    setLabel((node.data as any)?.label || '');
    setText((node.data as any)?.text || '');
    setWeight((node.data as any)?.weight ?? '');
    setThreshold((node.data as any)?.confidenceThreshold ?? '');
    setSelectedPrompt(String((node.data as any)?.promptId || ''));
  }, [node.id]);

  const handleSave = () => {
    onSave(node.id, {
      label,
      text,
      weight: weight === '' ? undefined : Number(weight),
      confidenceThreshold: threshold === '' ? undefined : Number(threshold),
    });
  };

  const handlePromptChange = (e: SelectChangeEvent<string>) => {
    const id = e.target.value;
    setSelectedPrompt(id);
    const p = prompts.find(pr => String(pr.id) === id);
    if (p) {
      setWeight(p.weight ?? '');
      setText(p.text);
      onSave(node.id, { promptId: id, text: p.text, weight: p.weight });
    } else {
      onSave(node.id, { promptId: id });
    }
  };

  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <FormControl size="small">
        <InputLabel id="prompt-select-label">Prompt</InputLabel>
        <Select
          labelId="prompt-select-label"
          value={selectedPrompt}
          label="Prompt"
          onChange={handlePromptChange}
        >
          {prompts.map(p => (
            <MenuItem key={p.id} value={String(p.id)}>
              <span
                style={{
                  display: 'block',
                  maxWidth: '230px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {p.text}
              </span>
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <TextField
        label="Label"
        size="small"
        value={label}
        onChange={e => setLabel(e.target.value)}
        aria-label="Node Label"
      />
      <TextField
        label="Text"
        size="small"
        multiline
        minRows={3}
        value={text}
        onChange={e => setText(e.target.value)}
        aria-label="Prompt Text"
      />
      <TextField
        label="Weight"
        type="number"
        size="small"
        value={weight}
        onChange={e => setWeight(e.target.value)}
        aria-label="Node Weight"
      />
      <TextField
        label="Threshold"
        type="number"
        size="small"
        value={threshold}
        onChange={e => setThreshold(e.target.value)}
        aria-label="Confidence Threshold"
      />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button variant="contained" size="small" onClick={handleSave} aria-label="Save Node">
          Save
        </Button>
      </Box>
    </Paper>
  );
}
