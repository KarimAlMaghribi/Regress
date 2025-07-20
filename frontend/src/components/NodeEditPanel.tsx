import React, { useState } from 'react';
import { Paper, Box, TextField, Button } from '@mui/material';
import { Node } from 'reactflow';

interface Props {
  node: Node;
  onSave: (id: string, data: { label: string; weight?: number; confidenceThreshold?: number }) => void;
}

export default function NodeEditPanel({ node, onSave }: Props) {
  const [label, setLabel] = useState<string>((node.data as any)?.label || '');
  const [weight, setWeight] = useState<string | number>((node.data as any)?.weight ?? '');
  const [threshold, setThreshold] = useState<string | number>((node.data as any)?.confidenceThreshold ?? '');

  const handleSave = () => {
    onSave(node.id, {
      label,
      weight: weight === '' ? undefined : Number(weight),
      confidenceThreshold: threshold === '' ? undefined : Number(threshold),
    });
  };

  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <TextField
        label="Label"
        size="small"
        value={label}
        onChange={e => setLabel(e.target.value)}
        aria-label="Node Label"
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
