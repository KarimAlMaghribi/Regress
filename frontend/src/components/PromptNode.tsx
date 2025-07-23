import React from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent, Divider, Typography } from '@mui/material';
import { Handle, Position } from 'reactflow';
import { Port } from '../types/Port';

interface PromptNodeData {
  label: string;
  text?: string;
  type: string;
  weight?: number;
  confidenceThreshold?: number;
  inPorts?: Port[];
  outPorts?: Port[];
}

interface Props {
  data: PromptNodeData;
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

  const inPorts = data.inPorts && data.inPorts.length
    ? data.inPorts
    : [{ id: 'in', side: 'left' }];
  const outPorts = data.outPorts && data.outPorts.length
    ? data.outPorts
    : [{ id: 'out', side: 'right' }];
  const handleCount = Math.max(inPorts.length, outPorts.length);

  return (
    <motion.div
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
    >
      <Card
        sx={{
          maxWidth: 250,
          fontSize: '0.875rem',
          position: 'relative',
          height: 40 + handleCount * 24,
        }}
      >
        {inPorts.map((p, i) => (
          <Handle
            key={p.id}
            type="target"
            id={p.id}
            position={Position.Left}
            style={{ top: 20 + i * 24 }}
          />
        ))}
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
        {outPorts.map((p, i) => (
          <Handle
            key={p.id}
            type="source"
            id={p.id}
            position={Position.Right}
            style={{ top: 20 + i * 24 }}
          />
        ))}
      </Card>
    </motion.div>
  );
}
