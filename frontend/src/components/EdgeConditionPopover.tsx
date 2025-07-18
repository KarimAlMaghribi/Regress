import React, { useState } from 'react';
import {
  Popover,
  Box,
  Select,
  MenuItem,
  TextField,
  Button,
} from '@mui/material';
import { Edge } from 'reactflow';

interface Props {
  edge: Edge;
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  onSave: (type: string, condition: string) => void;
}

export default function EdgeConditionPopover({ edge, anchorEl, open, onClose, onSave }: Props) {
  const [type, setType] = useState<string>((edge.data as any)?.edge_type ?? 'always');
  const [cond, setCond] = useState<string>((edge.data as any)?.label ?? '');

  const handleSave = () => {
    onSave(type, cond);
    onClose();
  };

  return (
    <Popover open={open} anchorEl={anchorEl} onClose={onClose}>
      <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1, minWidth: 200 }}>
        <Select size="small" value={type} onChange={e => setType(e.target.value as string)}>
          {['always', 'onTrue', 'onFalse', 'onScore', 'onError'].map(t => (
            <MenuItem key={t} value={t}>{t}</MenuItem>
          ))}
        </Select>
        {type === 'onScore' && (
          <TextField size="small" label="Condition" value={cond} onChange={e => setCond(e.target.value)} />
        )}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
          <Button size="small" onClick={onClose}>Cancel</Button>
          <Button size="small" variant="contained" onClick={handleSave}>Save</Button>
        </Box>
      </Box>
    </Popover>
  );
}
