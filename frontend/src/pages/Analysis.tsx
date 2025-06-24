import React, { useMemo, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  ListItemText,
  Button,
  Snackbar,
  Alert,
  Skeleton,
  Grid,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  OutlinedInput,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Brush,
} from 'recharts';
import { motion } from 'framer-motion';
import useMetrics, { MetricRecord } from '../hooks/useMetrics';

const ALL_METRICS: (keyof MetricRecord)[] = [
  'accuracy',
  'correctness',
  'relevance',
  'completeness',
  'hallucinationRate',
  'clarityScore',
  'formalityScore',
  'concisenessScore',
  'embeddingSimilarity',
  'avgLogprob',
];

const COLORS = [
  '#3A86FF',
  '#6C5DD3',
  '#FF6B6B',
  '#0CA678',
  '#F9C74F',
  '#F9844A',
  '#8338EC',
  '#0081A7',
  '#D00000',
  '#4361EE',
];

export default function PromptAnalysis() {
  const today = useMemo(() => new Date(), []);
  const [start, setStart] = useState<Date | null>(new Date(today.getTime() - 7 * 86400000));
  const [end, setEnd] = useState<Date | null>(today);
  const [metrics, setMetrics] = useState<(keyof MetricRecord)[]>(['accuracy']);
  const [rolling, setRolling] = useState(false);
  const [thresholds] = useState({ accuracy: 0.8, hallucinationRate: 0.2 });
  const [selectedPoint, setSelectedPoint] = useState<MetricRecord | null>(null);

  const { data, loading, error, refresh } = useMetrics({
    dateRange: start && end ? { start, end } : undefined,
    metrics,
    rollingAverage: rolling,
  });

  const latest = data.at(-1);
  const avgCost = useMemo(() => (data.reduce((s, d) => s + d.cost, 0) / Math.max(data.length, 1)).toFixed(4), [data]);
  const worstHallucination = useMemo(() => Math.max(...data.map(d => d.hallucinationRate || 0)), [data]);
  const alert = (latest && (latest.accuracy < thresholds.accuracy || latest.hallucinationRate > thresholds.hallucinationRate));

  const handlePointClick = (p: any) => {
    setSelectedPoint(p.activePayload?.[0]?.payload || null);
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Prompt Analysis</Typography>

      {/* KPI Cards */}
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item>
          <Paper sx={{ p: 2 }} component={motion.div} whileHover={{ scale: 1.02 }}>
            <Typography variant="subtitle2">Latest Accuracy</Typography>
            <Typography variant="h5">{latest?.accuracy?.toFixed(3) ?? '-'}</Typography>
          </Paper>
        </Grid>
        <Grid item>
          <Paper sx={{ p: 2 }} component={motion.div} whileHover={{ scale: 1.02 }}>
            <Typography variant="subtitle2">Avg Cost</Typography>
            <Typography variant="h5">{avgCost}</Typography>
          </Paper>
        </Grid>
        <Grid item>
          <Paper sx={{ p: 2 }} component={motion.div} whileHover={{ scale: 1.02 }}>
            <Typography variant="subtitle2">Worst Hallucination</Typography>
            <Typography variant="h5">{Number.isFinite(worstHallucination) ? worstHallucination.toFixed(3) : '-'}</Typography>
          </Paper>
        </Grid>
      </Grid>

      {alert && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Threshold breached! Accuracy &lt; {thresholds.accuracy} or Hallucination &gt; {thresholds.hallucinationRate}
        </Alert>
      )}

      <Paper sx={{ p: 2, mb: 2 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item>
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="metric-label">Metrics</InputLabel>
              <Select
                labelId="metric-label"
                multiple
                value={metrics}
                onChange={e => setMetrics(typeof e.target.value === 'string' ? [] : e.target.value as (keyof MetricRecord)[])}
                renderValue={selected => (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                    {(selected as string[]).map(value => <Chip key={value} label={value} />)}
                  </Box>
                )}
                input={<OutlinedInput label="Metrics" />}
              >
                {ALL_METRICS.map(m => (
                  <MenuItem key={m} value={m}>
                    <Checkbox checked={metrics.indexOf(m) > -1} />
                    <ListItemText primary={m} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item>
            <DatePicker
              label="Start"
              value={start}
              onChange={d => setStart(d ? new Date(d.toString()) : null)}
              slotProps={{ textField: { size: 'small' } }}
            />
          </Grid>
          <Grid item>
            <DatePicker
              label="End"
              value={end}
              onChange={d => setEnd(d ? new Date(d.toString()) : null)}
              slotProps={{ textField: { size: 'small' } }}
            />
          </Grid>
          <Grid item>
            <FormControl size="small">
              <Checkbox
                checked={rolling}
                onChange={e => setRolling(e.target.checked)}
              />
              <ListItemText primary="7d rolling" />
            </FormControl>
          </Grid>
          <Grid item>
            <Button variant="contained" onClick={refresh} component={motion.button} whileHover={{ y: -2 }}>
              Refresh
            </Button>
          </Grid>
        </Grid>
      </Paper>

      <Paper sx={{ p: 2 }}>
        {loading ? (
          <Skeleton variant="rectangular" height={300} />
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={data} onClick={handlePointClick}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="timestamp" />
              <YAxis />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              {metrics.map((m, idx) => (
                <Line key={m} type="monotone" dataKey={m} stroke={COLORS[idx % COLORS.length]} dot={false} />
              ))}
              <Brush dataKey="timestamp" height={20} stroke="#8884d8" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Paper>

      <Dialog open={!!selectedPoint} onClose={() => setSelectedPoint(null)} fullWidth maxWidth="md">
        <DialogTitle>Run Details</DialogTitle>
        {selectedPoint && (
          <DialogContent dividers>
            <Typography variant="subtitle2" gutterBottom>Prompt</Typography>
            <Typography paragraph sx={{ whiteSpace: 'pre-wrap' }}>{selectedPoint.prompt}</Typography>
            <Typography variant="subtitle2" gutterBottom>Input</Typography>
            <Typography paragraph sx={{ whiteSpace: 'pre-wrap' }}>{selectedPoint.input}</Typography>
            <Typography variant="subtitle2" gutterBottom>Response</Typography>
            {selectedPoint.responses?.map((r, i) => (
              <Paper key={i} sx={{ p: 1, mb: 1 }}>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{r}</Typography>
              </Paper>
            ))}
            <Typography variant="subtitle2" gutterBottom>Evaluation</Typography>
            <pre>{JSON.stringify({ correctness: selectedPoint.correctness, relevance: selectedPoint.relevance, completeness: selectedPoint.completeness }, null, 2)}</pre>
            <Typography variant="subtitle2" gutterBottom>Embedding Similarity</Typography>
            <Typography paragraph>{selectedPoint.embeddingSimilarity.toFixed(3)}</Typography>
            <Typography variant="subtitle2" gutterBottom>Moderation Flags</Typography>
            <Typography paragraph>{selectedPoint.moderationFlags.join(', ') || 'None'}</Typography>
            <Typography variant="subtitle2" gutterBottom>Cost / Tokens</Typography>
            <Typography>{selectedPoint.totalTokens} tokens, €{selectedPoint.cost.toFixed(4)}</Typography>
          </DialogContent>
        )}
      </Dialog>

      <Snackbar open={!!error} autoHideDuration={6000} onClose={() => {}}>
        <Alert severity="error">{error}</Alert>
      </Snackbar>
    </Box>
  );
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p: MetricRecord = payload[0].payload;
  return (
    <Paper sx={{ p: 1 }}>
      <Typography variant="caption">{p.timestamp}</Typography>
      {ALL_METRICS.map(m => (
        <Typography key={m} variant="body2">{m}: {(p as any)[m]}</Typography>
      ))}
      <Typography variant="body2">prompt: {p.promptId}</Typography>
      <Typography variant="body2">model: {p.modelVersion}</Typography>
      <Typography variant="body2">commit: {p.gitCommit}</Typography>
    </Paper>
  );
}
