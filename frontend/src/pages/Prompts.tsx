import React, { useEffect, useState } from 'react';
import { Typography, Box, TextField, Button, IconButton, List, ListItem } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { motion } from 'framer-motion';

interface Prompt {
  id: number;
  text: string;
}

export default function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newText, setNewText] = useState('');

  const load = () => {
    fetch('http://localhost:8082/prompts')
      .then(r => r.json())
      .then(setPrompts);
  };

  useEffect(() => { load(); }, []);

  const create = () => {
    fetch('http://localhost:8082/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: newText })
    }).then(() => { setNewText(''); load(); });
  };

  const update = (id: number, text: string) => {
    fetch(`http://localhost:8082/prompts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).then(load);
  };

  const remove = (id: number) => {
    fetch(`http://localhost:8082/prompts/${id}`, { method: 'DELETE' }).then(load);
  };

  return (
    <Box>
      <Typography variant="h4" gutterBottom>Prompts</Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
        <TextField size="small" value={newText} onChange={e => setNewText(e.target.value)} label="New prompt" />
        <Button variant="contained" onClick={create} component={motion.button} whileHover={{ y: -2 }}>Add</Button>
      </Box>
      <List>
        {prompts.map((p, idx) => (
          <ListItem key={p.id} sx={{ display: 'flex', gap: 1 }}>
            <TextField
              size="small"
              fullWidth
              value={p.text}
              onChange={e => {
                const arr = [...prompts];
                arr[idx] = { ...arr[idx], text: e.target.value };
                setPrompts(arr);
              }}
              onBlur={e => update(p.id, e.target.value)}
            />
            <IconButton component={motion.button} whileTap={{ rotate: 20 }} onClick={() => remove(p.id)}>
              <DeleteIcon />
            </IconButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
