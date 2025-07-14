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
  Slider,
  Checkbox,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Autocomplete,
  Dialog,
  DialogTitle,
  DialogContent,
  Paper,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import StarIcon from '@mui/icons-material/Star';
import InfoIcon from '@mui/icons-material/Info';
import { motion } from 'framer-motion';
import PageHeader from '../components/PageHeader';
import { usePromptNotifications } from '../context/PromptNotifications';
import { useTheme } from '@mui/material/styles';

interface Prompt {
  id: number;
  text: string;
  tags: string[];
  weight: number;
  favorite: boolean;
}

export default function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newText, setNewText] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'weight' | 'alphabet'>('date');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [edit, setEdit] = useState<Prompt | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkWeight, setBulkWeight] = useState(1);
  const [helpOpen, setHelpOpen] = useState(false);
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
          favorite: !!p.favorite,
          tags: JSON.parse(localStorage.getItem(`promptTags_${p.id}`) || '[]')
        }));
        setPrompts(data);
        markAllRead(d.map(p => p.id));
      })
      .catch(e => console.error('load prompts', e));
  };

  useEffect(() => {
    load();
    const saved = JSON.parse(localStorage.getItem('promptsSettings') || '{}');
    if (saved.search) setSearch(saved.search);
    if (saved.sortBy) setSortBy(saved.sortBy);
    if (Array.isArray(saved.tags)) setSelectedTags(saved.tags);
    if (saved.view) setViewMode(saved.view);
  }, []);

  useEffect(() => {
    localStorage.setItem('promptsSettings', JSON.stringify({
      search,
      sortBy,
      tags: selectedTags,
      view: viewMode,
    }));
  }, [search, sortBy, selectedTags, viewMode]);

  const create = () => {
    fetch('http://localhost:8082/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: newText, weight: newWeight, favorite: false })
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
    const fav = prompts.find(p => p.id === id)?.favorite ?? false;
    fetch(`http://localhost:8082/prompts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, tags, weight, favorite: fav })
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
      load();
    }).catch(e => console.error('remove prompt', e));
  };

  const toggleFav = (id: number) => {
    const p = prompts.find(pr => pr.id === id);
    if (!p) return;
    fetch(`http://localhost:8082/prompts/${id}/favorite`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: !p.favorite })
    })
      .then(async r => {
        if (!r.ok) { const j = await r.json(); throw new Error(j.error || r.statusText); }
        return r.json();
      })
      .then(() => load())
      .catch(e => console.error('toggle favorite', e));
  };

  const applyBulkWeight = () => {
    Promise.all(selectedIds.map(id => {
      const p = prompts.find(pr => pr.id === id);
      if (!p) return Promise.resolve();
      return fetch(`http://localhost:8082/prompts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: p.text, tags: p.tags, weight: bulkWeight })
      }).then(async r => {
        if (!r.ok) {
          const j = await r.json();
          throw new Error(j.error || r.statusText);
        }
        localStorage.setItem(`promptTags_${id}`, JSON.stringify(p.tags));
      });
    }))
      .then(() => { setSelectedIds([]); load(); })
      .catch(e => console.error('bulk weight', e));
  };

  const bulkDelete = () => {
    Promise.all(selectedIds.map(id =>
      fetch(`http://localhost:8082/prompts/${id}`, { method: 'DELETE' }).then(async r => {
        if (!r.ok) {
          const j = await r.json();
          throw new Error(j.error || r.statusText);
        }
        localStorage.removeItem(`promptTags_${id}`);
      })
    ))
      .then(() => {
        setSelectedIds([]);
        load();
      })
      .catch(e => console.error('bulk delete', e));
  };

  const tags = useMemo(() => Array.from(new Set(prompts.flatMap(p => p.tags))), [prompts]);

  const displayed = prompts.filter(p => {
    if (search && !p.text.toLowerCase().includes(search.toLowerCase())) return false;
    if (selectedTags.length && !selectedTags.some(t => p.tags.includes(t))) return false;
    return true;
  });

  const sorted = useMemo(() => {
    const arr = [...displayed];
    if (sortBy === 'weight') arr.sort((a, b) => b.weight - a.weight);
    else if (sortBy === 'alphabet') arr.sort((a, b) => a.text.localeCompare(b.text));
    else arr.sort((a, b) => b.id - a.id);
    return arr;
  }, [displayed, sortBy]);

  const favPrompts = sorted.filter(p => p.favorite);
  const others = sorted.filter(p => !p.favorite);

  const renderPrompt = (p: Prompt) => {
    const isSelected = selectedIds.includes(p.id);
    const toggle = (checked: boolean) => setSelectedIds(s => checked ? [...s, p.id] : s.filter(i => i !== p.id));

    return (
      <Box key={p.id} sx={{ position: 'relative' }} component={motion.div} whileHover={{ y: -2 }}>
        {isMobile ? (
          <ListItem onClick={() => setEdit(p)} sx={{ flexDirection: 'column', alignItems: 'flex-start' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
              <Checkbox checked={isSelected} onChange={e => { e.stopPropagation(); toggle(e.target.checked); }} />
              <Box sx={{ flexGrow: 1, display: 'flex', justifyContent: 'space-between' }}>
                <Typography variant="subtitle1">{p.text.slice(0, 40)}</Typography>
                <IconButton onClick={(e) => { e.stopPropagation(); toggleFav(p.id); }} size="small">
                  <StarIcon color={p.favorite ? 'warning' : 'disabled'} />
                </IconButton>
              </Box>
            </Box>
            <Box sx={{ mt: 0.5 }}>
              {p.tags.map(t => <Chip key={t} label={t} size="small" sx={{ mr: 0.5 }} />)}
            </Box>
          </ListItem>
        ) : (
          <Card onClick={() => setEdit(p)} sx={{ height: '100%', position: 'relative' }} component={motion.div} whileHover={{ scale: 1.02 }}>
            <Checkbox
              checked={isSelected}
              onChange={e => { e.stopPropagation(); toggle(e.target.checked); }}
              sx={{ position: 'absolute', top: 0, left: 0 }}
            />
            <CardContent>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="subtitle1">{p.text.slice(0, 40)}</Typography>
                <IconButton onClick={(e) => { e.stopPropagation(); toggleFav(p.id); }} size="small">
                  <StarIcon color={p.favorite ? 'warning' : 'disabled'} />
                </IconButton>
              </Box>
              {p.tags.map(t => <Chip key={t} label={t} size="small" sx={{ mr: 0.5 }} />)}
            </CardContent>
          </Card>
        )}
      </Box>
    );
  };

  return (
    <Box>
      <PageHeader title="Prompts" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Prompts' }]} />
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2, alignItems: 'center' }}>
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
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel id="sort-label">Sort by</InputLabel>
          <Select labelId="sort-label" value={sortBy} label="Sort by" onChange={e => setSortBy(e.target.value as any)}>
            <MenuItem value="date">Datum</MenuItem>
            <MenuItem value="weight">Gewicht</MenuItem>
            <MenuItem value="alphabet">Alphabet</MenuItem>
          </Select>
        </FormControl>
        <TextField size="small" value={search} onChange={e => setSearch(e.target.value)} label="Search" />
        <Autocomplete
          multiple
          options={tags}
          value={selectedTags}
          onChange={(_, v) => setSelectedTags(v)}
          size="small"
          sx={{ minWidth: 180 }}
          renderInput={(params) => <TextField {...params} label="Tags" />}
        />
        <Typography variant="caption">{`${selectedTags.length} / ${tags.length} tags`}</Typography>
        <IconButton onClick={() => setHelpOpen(true)} size="small"><InfoIcon /></IconButton>
      </Box>

      {selectedIds.length > 0 && (
        <Paper sx={{ p: 1, mb: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
          <Typography>{selectedIds.length} selected</Typography>
          <Slider
            value={bulkWeight}
            onChange={(_, v) => setBulkWeight(v as number)}
            min={0}
            max={10}
            step={1}
            valueLabelDisplay="auto"
            sx={{ width: 160 }}
          />
          <Button variant="contained" onClick={applyBulkWeight}>Set weight</Button>
          <Button color="error" variant="outlined" onClick={bulkDelete}>Delete selected</Button>
        </Paper>
      )}

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
            <Typography gutterBottom>Gewichtung</Typography>
            <Slider
              value={edit.weight}
              onChange={(_, v) => setEdit({ ...edit, weight: v as number })}
              step={1}
              min={0}
              max={10}
              valueLabelDisplay="on"
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

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)}>
        <DialogTitle>Tipps für gute Prompts</DialogTitle>
        <DialogContent>
          <ul>
            <li>Use action verbs</li>
            <li>Be specific</li>
            <li>Keep under 140 characters</li>
          </ul>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
