import React, { useState } from 'react';
import { Box, Typography, LinearProgress, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface Rule { if: string; label: string }

interface Props {
  score: number;
  label: string;
  rules: Rule[];
}

export default function FinalPromptInfo({ score, label, rules }: Props) {
  const [open, setOpen] = useState(false);

  const active = rules.find(r => {
    try {
      // eslint-disable-next-line no-eval
      return eval(r.if.replace(/score/g, String(score)));
    } catch {
      return false;
    }
  });

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle1">Endscore: {score.toFixed(2)}</Typography>
      <LinearProgress variant="determinate" value={score * 100} sx={{ mb: 1 }} />
      {active && (
        <Typography variant="body2" sx={{ mb: 1 }}>
          Active Label Rule: {active.label}
        </Typography>
      )}
      <Accordion expanded={open} onChange={(_, exp) => setOpen(exp)}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          Show Final Prompt Definition
        </AccordionSummary>
        <AccordionDetails>
          <pre>{JSON.stringify({ scoreFormula: 'score', labelRules: rules }, null, 2)}</pre>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}
