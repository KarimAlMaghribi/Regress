import React, { useEffect, useState } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import PageHeader from '../components/PageHeader';

interface HistoryEntry {
  timestamp: string;
  result: any;
  pdfUrl: string;
  [key: string]: any;
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<HistoryEntry | null>(null);

  useEffect(() => {
    const socket = new WebSocket(`ws://${location.host}`);
    socket.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'history') {
        setEntries(msg.data);
      } else if (msg.type === 'update') {
        setEntries(e => [msg.data, ...e]);
      }
    });
    return () => socket.close();
  }, []);

  return (
    <Box>
      <PageHeader title="History" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'History' }]} />
      <Paper id="list" sx={{ maxHeight: 300, overflowY: 'auto', mb: 2 }}>
        {entries.map((e, i) => (
          <Box
            key={i}
            onClick={() => setSelected(e)}
            sx={{ p: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
          >
            <Typography variant="body2">
              {e.timestamp}: {JSON.stringify(e.result)}
            </Typography>
          </Box>
        ))}
      </Paper>
      {selected && (
        <Box id="detail">
          <iframe src={selected.pdfUrl} width="400" height="600" title="pdf" />
          <Box component="pre" sx={{ whiteSpace: 'pre-wrap' }} id="meta">
            {JSON.stringify(selected, null, 2)}
          </Box>
        </Box>
      )}
    </Box>
  );
}
