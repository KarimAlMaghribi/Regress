import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Paper,
  Chip,
  CircularProgress,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Stack,
  Alert,
  Skeleton,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { motion } from 'framer-motion';
import { useLatestRun } from '../context/LatestRun';
import { toast } from 'react-hot-toast';

interface PromptResult {
  prompt_id: string;
  prompt_type: string;
  answer?: string;
  source?: string;
}

interface RunResult {
  score: number;
  label: string;
  history: PromptResult[];
}

const chipIcon: Record<string, string> = {
  success: '✅',
  warning: '⚠️',
  error: '⛔',
};

const typeEmoji: Record<string, string> = {
  Trigger: '🚦',
  Analysis: '🔍',
  FollowUp: '🔁',
  Decision: '⚖️',
  Final: '🎯',
  Meta: '🧩',
};

function SummaryCard({ data }: { data: RunResult }) {
  const color =
    data.label === 'KEIN_REGRESS'
      ? 'success'
      : data.label.includes('M')
      ? 'warning'
      : 'error';
  return (
    <Paper
      component={motion.div}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      sx={{ p: 2, minWidth: 280 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <Chip
          label={data.label}
          color={color as any}
          icon={<span>{chipIcon[color]}</span>}
        />
        <CircularProgress variant="determinate" value={data.score * 100} />
        <Typography>{(data.score * 100).toFixed(1)}%</Typography>
      </Stack>
    </Paper>
  );
}

function PromptDetails({ history }: { history: PromptResult[] }) {
  const listVariants = {
    hidden: {},
    show: {
      transition: { staggerChildren: 0.1 },
    },
  };
  const itemVariants = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0 },
  };
  return (
    <Box
      component={motion.div}
      variants={listVariants}
      initial="hidden"
      animate="show"
      sx={{ flexGrow: 1 }}
    >
      {history.map((h, i) => (
        <Accordion
          key={i}
          component={motion.div}
          variants={itemVariants}
        >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography>
              {typeEmoji[h.prompt_type] || ''} {h.prompt_id}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            {h.answer && (
              <Typography paragraph sx={{ whiteSpace: 'pre-wrap' }}>
                {h.answer}
              </Typography>
            )}
            {h.source && (
              <Alert
                severity="info"
                icon={<span>📄</span>}
                sx={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}
              >
                {h.source}
              </Alert>
            )}
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}

export default function Result() {
  const { id } = useParams<{ id: string }>();
  const backend = import.meta.env.VITE_CLASSIFIER_URL || 'http://localhost:8084';
  const { setLatestRun } = useLatestRun();
  const { data, isLoading } = useQuery<RunResult>(
    `/runs/${id}`,
    async () => {
      const res = await fetch(`${backend}/runs/${id}`);
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    },
    { enabled: !!id }
  );

  useEffect(() => {
    if (data) {
      setLatestRun(data as any);
      toast.success(`\ud83c\udf7e Analyse abgeschlossen (Label: ${data.label})`);
    }
  }, [data, setLatestRun]);

  if (isLoading || !data) {
    return <Skeleton variant="rectangular" height={200} />;
  }

  return (
    <Stack direction="row" spacing={2} alignItems="flex-start">
      <SummaryCard data={data} />
      <PromptDetails history={data.history} />
    </Stack>
  );
}
