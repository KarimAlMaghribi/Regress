import React, { useEffect, useMemo, useState } from 'react';
import {
  Typography,
  Box,
  TextField,
  Button,
  IconButton,
  Grid,
  Card,
  CardContent,
  Chip,
  List,
  ListItem,
  Drawer,
  useMediaQuery,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import StarIcon from '@mui/icons-material/Star';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader';
import { usePromptNotifications } from '../context/PromptNotifications';
import { useTheme } from '@mui/material/styles';

interface Prompt {
  id: number;
  text: string;
  tags: string[];
  weight: number;
}

export default function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newText, setNewText] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<string | null>(null);
  const [edit, setEdit] = useState<Prompt | null>(null);
  const [favorites, setFavorites] = useState<number[]>(() => JSON.parse(localStorage.getItem('favoritePrompts') || '[]'));
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { markAllRead } = usePromptNotifications();

  const load = () => {
    fetch('http://localhost:8082/prompts')
      .then(async r => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error || r.statusText);
        return json as any[];
      })
      .then((d: any[]) => {
        const data = d.map(p => ({
          ...p,
          weight: p.weight ?? 1,
          tags: JSON.parse(localStorage.getItem(`promptTags_${p.id}`) || '[]')
        }));
        setPrompts(data);
        markAllRead(d.map(p => p.id));
      })
      .catch(e => console.error('load prompts', e));
  };

  useEffect(() => {
    load();
  }, []);

  const create = () => {
    fetch('http://localhost:8082/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: newText, weight: newWeight })
    }).then(async r => {
      if (!r.ok) {
        const j = await r.json();
        throw new Error(j.error || r.statusText);
      }
      setNewText('');
      setNewWeight(1);
      load();
    }).catch(e => console.error('create prompt', e));
  };

  const update = (id: number, text: string, tags: string[], weight: number) => {
    fetch(`http://localhost:8082/prompts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, tags, weight })
    }).then(async r => {
      if (!r.ok) {
        const j = await r.json();
        throw new Error(j.error || r.statusText);
      }
      localStorage.setItem(`promptTags_${id}`, JSON.stringify(tags));
      load();
    }).catch(e => console.error('update prompt', e));
  };

  const remove = (id: number) => {
    fetch(`http://localhost:8082/prompts/${id}`, { method: 'DELETE' }).then(async r => {
      if (!r.ok) {
        const j = await r.json();
        throw new Error(j.error || r.statusText);
      }
      localStorage.removeItem(`promptTags_${id}`);
      setFavorites(f => f.filter(v => v !== id));
      load();
    }).catch(e => console.error('remove prompt', e));
  };

  const toggleFav = (id: number) => {
    setFavorites(f => {
      const n = f.includes(id) ? f.filter(v => v !== id) : [...f, id];
      localStorage.setItem('favoritePrompts', JSON.stringify(n));
      return n;
    });
  };

  const tags = useMemo(() => Array.from(new Set(prompts.flatMap(p => p.tags))), [prompts]);

  const displayed = prompts.filter(p => {
    if (search && !p.text.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter && !p.tags.includes(filter)) return false;
    return true;
  });

  const favPrompts = displayed.filter(p => favorites.includes(p.id));
  const others = displayed.filter(p => !favorites.includes(p.id));

  const renderPrompt = (p: Prompt) => (
    <Box key={p.id} sx={{ position: 'relative' }} component={motion.div} whileHover={{ y: -2 }}>
      {isMobile ? (
        <ListItem onClick={() => setEdit(p)} sx={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <Box sx={{ width: '100%', display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="subtitle1">{p.text.slice(0, 40)}</Typography>
            <IconButton onClick={(e) => { e.stopPropagation(); toggleFav(p.id); }} size="small">
              <StarIcon color={favorites.includes(p.id) ? 'warning' : 'disabled'} />
            </IconButton>
          </Box>
          <Box sx={{ mt: 0.5 }}>
            {p.tags.map(t => <Chip key={t} label={t} size="small" sx={{ mr: 0.5 }} />)}
          </Box>
        </ListItem>
      ) : (
        <Card onClick={() => setEdit(p)} sx={{ height: '100%' }} component={motion.div} whileHover={{ scale: 1.02 }}>
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="subtitle1">{p.text.slice(0, 40)}</Typography>
              <IconButton onClick={(e) => { e.stopPropagation(); toggleFav(p.id); }} size="small">
                <StarIcon color={favorites.includes(p.id) ? 'warning' : 'disabled'} />
              </IconButton>
            </Box>
            {p.tags.map(t => <Chip key={t} label={t} size="small" sx={{ mr: 0.5 }} />)}
          </CardContent>
        </Card>
      )}
    </Box>
  );

  return (
    <Box>
      <PageHeader title="Prompts" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Prompts' }]} />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
        <TextField size="small" value={newText} onChange={e => setNewText(e.target.value)} label="New prompt" />
        <TextField
          size="small"
          label="Weight"
          type="number"
          inputProps={{ min: 1, max: 10 }}
          value={newWeight}
          onChange={e => setNewWeight(Math.max(1, Math.min(10, +e.target.value)))}
        />
        <Button variant="contained" onClick={create} component={motion.button} whileHover={{ y: -2 }}>Add</Button>
        <Box sx={{ flexGrow: 1 }} />
        <TextField size="small" value={search} onChange={e => setSearch(e.target.value)} label="Search" />
        {tags.map(t => (
          <Chip
            key={t}
            label={t}
            clickable
            onClick={() => setFilter(f => (f === t ? null : t))}
            color={filter === t ? 'primary' : 'default'}
            sx={{ mr: 0.5 }}
          />
        ))}
      </Box>

      {favPrompts.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ mb: 1 }}>Meine Favoriten</Typography>
          {isMobile ? (
            <List>{favPrompts.map(renderPrompt)}</List>
          ) : (
            <Grid container spacing={2}>{favPrompts.map(p => (<Grid item xs={12} sm={6} md={4} key={p.id}>{renderPrompt(p)}</Grid>))}</Grid>
          )}
        </Box>
      )}

      {isMobile ? (
        <List>{others.map(renderPrompt)}</List>
      ) : (
        <Grid container spacing={2}>{others.map(p => (<Grid item xs={12} sm={6} md={4} key={p.id}>{renderPrompt(p)}</Grid>))}</Grid>
      )}

      <Drawer anchor="right" open={!!edit} onClose={() => setEdit(null)}>
        {edit && (
          <Box sx={{ width: { xs: 280, sm: 400 }, p: 2 }}>
            <TextField
              label="Prompt"
              multiline
              minRows={3}
              fullWidth
              value={edit.text}
              onChange={e => setEdit({ ...edit, text: e.target.value })}
              sx={{ mb: 1 }}
            />
            <TextField
              label="Tags (comma separated)"
              fullWidth
              value={edit.tags.join(', ')}
              onChange={e => setEdit({ ...edit, tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
              sx={{ mb: 1 }}
            />
            <TextField
              label="Gewichtung"
              type="number"
              inputProps={{ min: 1, max: 10 }}
              value={edit.weight}
              onChange={e => setEdit({ ...edit, weight: Math.max(1, Math.min(10, +e.target.value)) })}
              sx={{ mb: 1 }}
            />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <IconButton onClick={() => edit && remove(edit.id)}>
                <DeleteIcon />
              </IconButton>
              <Button variant="contained" onClick={() => edit && update(edit.id, edit.text, edit.tags, edit.weight)}>Save</Button>
            </Box>
          </Box>
        )}
      </Drawer>
    </Box>
  );
}
