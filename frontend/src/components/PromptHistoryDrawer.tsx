import React from 'react';
import { SwipeableDrawer, Box, Typography, List, ListItem, Tooltip, Fab } from '@mui/material';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import { motion } from 'framer-motion';
import { useLatestRun } from '../context/LatestRun';
import { PromptResult } from '../types/pipeline';

export default function PromptHistoryDrawer() {
  const { latestRun } = useLatestRun();
  const [open, setOpen] = React.useState(false);

  const results: PromptResult[] = (latestRun as any)?.promptResults || (latestRun as any)?.history || [];

  const duration = (s?: string, e?: string) => {
    if (!s || !e) return '';
    const d = new Date(e).getTime() - new Date(s).getTime();
    return `${d} ms`;
  };

  return (
    <>
      <Box sx={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1200 }}>
        <Fab
          color="primary"
          onClick={() => setOpen(true)}
          component={motion.div}
          animate={{ y: [0, -6, 0] }}
          transition={{ repeat: Infinity, duration: 1.6 }}
        >
          <HistoryOutlinedIcon />
        </Fab>
      </Box>
      <SwipeableDrawer anchor="right" open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)}>
        <Box sx={{ width: 320 }}>
          <Typography variant="h6" sx={{ p: 2 }}>
            🔍 Prompt‑Chronik
          </Typography>
          <List>
            {results.map((r, i) => (
              <Tooltip key={i} title={r.answer ? r.answer.slice(0, 80) : ''} placement="left">
                <ListItem
                  sx={{
                    borderLeft: 4,
                    borderColor:
                      r.result === true
                        ? 'error.main'
                        : r.result === false
                        ? 'success.main'
                        : 'grey.500',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                  }}
                >
                  <Typography variant="body2">{r.promptId}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {duration(r.startedAt, r.finishedAt)}
                  </Typography>
                </ListItem>
              </Tooltip>
            ))}
            {results.length === 0 && (
              <Typography sx={{ p: 2 }} color="text.secondary">
                Keine Daten
              </Typography>
            )}
          </List>
        </Box>
      </SwipeableDrawer>
    </>
  );
}
