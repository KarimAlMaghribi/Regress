import React from 'react';
import { Box } from '@mui/material';
import StageLane from './StageLane';

export default function StageLanesBoard() {
  return (
      <Box sx={{ display: 'flex', gap: 2, p: 1, overflowX: 'auto' }}>
        <StageLane promptType="TriggerPrompt" accentColor="#e3f2fd" />
        <StageLane promptType="AnalysisPrompt" accentColor="#fffde7" />
        <StageLane promptType="DecisionPrompt" accentColor="#ffe0b2" />
        <StageLane promptType="FinalPrompt" accentColor="#e8f5e9" />
      </Box>
  );
}
