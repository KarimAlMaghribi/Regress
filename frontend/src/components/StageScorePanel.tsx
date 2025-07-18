import React from 'react';
import { Box, Typography, LinearProgress } from '@mui/material';

export interface StageInfo {
  id: string;
  name: string;
  score: number;
}

export default function StageScorePanel({ stages }: { stages: StageInfo[] }) {
  return (
    <Box sx={{ mt: 1 }}>
      {stages.map(s => (
        <Box key={s.id} sx={{ mb: 1 }}>
          <Typography variant="body2" gutterBottom>
            {s.name}
          </Typography>
          <LinearProgress variant="determinate" value={s.score * 100} sx={{ mb: 0.5 }} />
          <Typography variant="caption">{(s.score * 100).toFixed(0)}%</Typography>
        </Box>
      ))}
    </Box>
  );
}
