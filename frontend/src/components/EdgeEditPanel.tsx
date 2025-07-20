import React, { useState } from 'react';
import { Paper, Box, Button, Select, MenuItem, TextField } from '@mui/material';
import { Edge } from 'reactflow';

interface Props {
  edge: Edge;
  onSave: (id: string, type: string, condition: string) => void;
}

export default function EdgeEditPanel({ edge, onSave }: Props) {
  const [type, setType] = useState<string>((edge.data as any)?.edge_type ?? 'always');
  const [condition, setCondition] = useState<string>((edge.data as any)?.label ?? '');

  const handleSave = () => {
    onSave(edge.id, type, condition);
  };

  return (
    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Select
        size="small"
        value={type}
        onChange={e => setType(e.target.value as string)}
        aria-label="Edge Type"
      >
        {['always', 'onTrue', 'onFalse', 'onScore', 'onError'].map(t => (
          <MenuItem key={t} value={t}>
            {t}
          </MenuItem>
        ))}
      </Select>
      {type === 'onScore' && (
        <TextField
          label="Condition"
          size="small"
          value={condition}
          onChange={e => setCondition(e.target.value)}
          aria-label="Edge Condition"
        />
      )}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button variant="contained" size="small" onClick={handleSave} aria-label="Save Edge">
          Save
        </Button>
      </Box>
    </Paper>
  );
}
