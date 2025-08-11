import React, { useState } from 'react';
import { Box, TextField, Button } from '@mui/material';
import { PipelineStep, usePipelineStore } from '../../hooks/usePipelineStore';

interface Props {
  step: PipelineStep;
  onSave?: (changes: Partial<PipelineStep>) => void;
}

export default function StepDialog({ step, onSave }: Props) {
  const { updateStep } = usePipelineStore();
  const [yesKey, setYesKey] = useState(step.yesKey || '');
  const [noKey, setNoKey] = useState(step.noKey || '');

  const valid = yesKey.trim() !== '' && noKey.trim() !== '';

  const handleSave = () => {
    if (!valid) return;
    const changes = { yesKey, noKey };
    if (onSave) {
      onSave(changes);
    } else {
      updateStep(step.id, changes).catch(() => {});
    }
  };

  return (
    <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <TextField
        label="Yes-Key"
        fullWidth
        required
        value={yesKey}
        onChange={e => setYesKey(e.target.value)}
        error={yesKey.trim() === ''}
      />
      <TextField
        label="No-Key"
        fullWidth
        required
        value={noKey}
        onChange={e => setNoKey(e.target.value)}
        error={noKey.trim() === ''}
      />
      <Button variant="contained" disabled={!valid} onClick={handleSave}>
        Save Keys
      </Button>
    </Box>
  );
}
