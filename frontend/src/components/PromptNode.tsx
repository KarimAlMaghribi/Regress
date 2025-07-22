import React from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, Divider, Typography } from '@mui/material';
import { Handle, Position } from 'reactflow';

interface Props {
  data: any;
  onRepeat?: () => void;
}

export default function PromptNode({ data, onRepeat }: Props) {
  const icons: Record<string, string> = {
    TriggerPrompt: '🟡',
    AnalysisPrompt: '🟢',
    FollowUpPrompt: '🔁',
    DecisionPrompt: '⚖️',
    FinalPrompt: '🟣',
    MetaPrompt: '⚙️',
  };

  return (
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
    >
      <Card sx={{ maxWidth: 250, fontSize: '0.875rem', position: 'relative' }}>
        <Handle type="target" id="in" position={Position.Left} />
        <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
          <Typography variant="subtitle2" gutterBottom>
            {icons[data.type] || '⚙️'} {data.label}
          </Typography>
          {data.text && (
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {data.text}
            </Typography>
          )}
          {(data.weight !== undefined || data.confidenceThreshold !== undefined) && (
            <>
              <Divider sx={{ my: 0.5 }} />
              {data.weight !== undefined && (
                <Typography variant="caption" display="block">
                  Gewicht: {data.weight}
                </Typography>
              )}
              {data.confidenceThreshold !== undefined && (
                <Typography variant="caption" display="block">
                  Schwelle: {data.confidenceThreshold}
                </Typography>
              )}
            </>
          )}
        </CardContent>
        <Handle type="source" id="out" position={Position.Right} />
      </Card>
    </motion.div>
  );
}
