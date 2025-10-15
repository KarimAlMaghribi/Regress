import React, { useEffect, useState } from 'react';
import { Box, TextField, Button, Typography } from '@mui/material';
import { PipelineStep, usePipelineStore } from '../../hooks/usePipelineStore';

interface Props {
  step: PipelineStep;
  onSave?: (changes: Partial<PipelineStep>) => void;
}

export default function StepDialog({ step, onSave }: Props) {
  const { updateStep } = usePipelineStore();
  const [yesKey, setYesKey] = useState(step.yesKey || '');
  const [noKey, setNoKey] = useState(step.noKey || '');
  const [minConfidence, setMinConfidence] = useState<number>(() => {
    const raw = (step.config as any)?.min_confidence;
    return typeof raw === 'number' ? raw : 0;
  });

  useEffect(() => {
    setYesKey(step.yesKey || '');
    setNoKey(step.noKey || '');
    const raw = (step.config as any)?.min_confidence;
    setMinConfidence(typeof raw === 'number' ? raw : 0);
  }, [step]);

  const valid = yesKey.trim() !== '' && noKey.trim() !== '';

  const handleSave = () => {
    if (!valid) return;
    const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
    const normalized = clamp01(Number.isFinite(minConfidence) ? minConfidence : 0);
    const rounded = Math.round(normalized * 1000) / 1000;

    const nextConfig: Record<string, unknown> = { ...(step.config ?? {}) };
    if (rounded > 0) {
      nextConfig['min_confidence'] = rounded;
    } else {
      delete nextConfig['min_confidence'];
    }

    const changes: Partial<PipelineStep> = {
      yesKey: yesKey.trim(),
      noKey: noKey.trim(),
    };

    if (Object.keys(nextConfig).length > 0) {
      changes.config = nextConfig;
    } else if (step.config && Object.keys(step.config).length > 0) {
      // explizit leeren, damit alte Werte entfernt werden
      changes.config = {};
    }

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
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          Min. Confidence (0..1)
        </Typography>
        <TextField
          type="number"
          fullWidth
          value={minConfidence}
          inputProps={{ step: 0.05, min: 0, max: 1 }}
          onChange={(e) => {
            const val = Number(e.target.value);
            setMinConfidence(Number.isFinite(val) ? val : 0);
          }}
          helperText="Finale Decision nur speichern, wenn die Konfidenz ≥ Schwelle ist"
        />
      </Box>
      <Button variant="contained" disabled={!valid} onClick={handleSave}>
        Save Keys
      </Button>
    </Box>
  );
}
