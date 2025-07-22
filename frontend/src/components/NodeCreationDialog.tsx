import { useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  useMediaQuery,
} from '@mui/material';

export interface NodeCreationData {
  label?: string;
  text?: string;
  weight?: number;
  confidenceThreshold?: number;
}

interface Props {
  open: boolean;
  type: string;
  onCreate: (data: NodeCreationData) => void;
  onCancel: () => void;
}

export default function NodeCreationDialog({ open, type, onCreate, onCancel }: Props) {
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [weight, setWeight] = useState('');
  const [threshold, setThreshold] = useState('');

  const reset = () => {
    setLabel('');
    setText('');
    setWeight('');
    setThreshold('');
  };

  const handleCreate = () => {
    onCreate({
      label: label || undefined,
      text,
      weight: weight === '' ? undefined : Number(weight),
      confidenceThreshold: threshold === '' ? undefined : Number(threshold),
    });
    reset();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onCancel();
      }}
      fullWidth
      fullScreen={useMediaQuery('(max-width:600px)')}
    >
      <DialogTitle>Neuer {type}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <TextField
          label="Label"
          size="small"
          value={label}
          onChange={e => setLabel(e.target.value)}
          aria-label="Node Label"
        />
        <TextField
          label="Text"
          size="small"
          multiline
          minRows={3}
          value={text}
          onChange={e => setText(e.target.value)}
          aria-label="Prompt Text"
        />
        <TextField
          label="Weight"
          type="number"
          size="small"
          value={weight}
          onChange={e => setWeight(e.target.value)}
          aria-label="Node Weight"
        />
        <TextField
          label="Threshold"
          type="number"
          size="small"
          value={threshold}
          onChange={e => setThreshold(e.target.value)}
          aria-label="Confidence Threshold"
        />
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            reset();
            onCancel();
          }}
        >
          Abbrechen
        </Button>
        <Button onClick={handleCreate} variant="contained">
          ➕ Hinzufügen
        </Button>
      </DialogActions>
    </Dialog>
  );
}
