import React, { useEffect, useState } from 'react';
import {
  Box,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Modal,
  Paper,
  Typography,
} from '@mui/material';
import { motion, AnimatePresence } from 'framer-motion';
import { PipelineRunResult } from '../types/pipeline';

export default function Result() {
  const [results, setResults] = useState<PipelineRunResult[]>([]);
  const [selected, setSelected] = useState<PipelineRunResult | null>(null);

  useEffect(() => {
    fetch('/analyses?limit=20')
      .then(r => r.json())
      .then(setResults)
      .catch(e => console.error('load analyses', e));
  }, []);

  const color = (label: string) =>
    label.includes('KEIN') ? '✅' : label.includes('M') ? '⚠️' : '❌';

  return (
    <Box>
      <Paper sx={{ p: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>🆔</TableCell>
              <TableCell>📄 PDF</TableCell>
              <TableCell>🏷️ Label</TableCell>
              <TableCell>🧮 Score</TableCell>
              <TableCell>⏰ Timestamp</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {results.map(r => (
              <TableRow
                key={r.id}
                hover
                onClick={() => setSelected(r)}
                sx={{ cursor: 'pointer' }}
              >
                <TableCell>{r.id}</TableCell>
                <TableCell>{r.pdfId}</TableCell>
                <TableCell>{color(r.label)} {r.label}</TableCell>
                <TableCell>{r.finalScore.toFixed(2)}</TableCell>
                <TableCell>{new Date(r.finishedAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
      <AnimatePresence>
        {selected && (
          <Modal open onClose={() => setSelected(null)}>
            <Box
              component={motion.div}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              sx={{ maxWidth: 600, bgcolor: 'background.paper', p: 2, m: '10% auto' }}
            >
              <Typography variant="h6" gutterBottom>
                History for run {selected.id}
              </Typography>
              {selected.promptResults.map((h, i) => (
                <Box key={i} sx={{ mb: 1 }}>
                  <strong>{h.promptType}</strong> {h.promptId} –{' '}
                  {h.result ?? ''}
                  {h.answer && (
                    <pre style={{ whiteSpace: 'pre-wrap' }}>{h.answer}</pre>
                  )}
                  {h.source && <em>📄 {h.source}</em>}
                </Box>
              ))}
            </Box>
          </Modal>
        )}
      </AnimatePresence>
    </Box>
  );
}
