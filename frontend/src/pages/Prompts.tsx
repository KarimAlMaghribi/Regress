import React, { useEffect, useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Slider,
  Card,
  CardContent,
  CardActions,
  Chip,
  Tooltip,
  Stack,
  Divider,
  Typography,
} from '@mui/material';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import TextSnippetIcon from '@mui/icons-material/TextSnippet';
import LeaderboardIcon from '@mui/icons-material/Leaderboard';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import PageHeader from '../components/PageHeader';

type PromptType = 'ExtractionPrompt' | 'ScoringPrompt' | 'DecisionPrompt';

interface Prompt {
  id: number;
  text: string;
  weight: number;
  json_key?: string; // Backend-Feld bleibt bestehen – UI nennt es "Name"
  favorite: boolean;
  type: PromptType;
}

declare global {
  interface Window {
    __ENV__?: any;
  }
}

const getBase = () =>
    (window as any).__ENV__?.PROMPT_API_URL ||
    import.meta.env?.VITE_PROMPT_API_URL ||
    'http://localhost:8082';

// Farblogik + Icons pro Typ
const typeMeta = (t: PromptType) => {
  switch (t) {
    case 'ExtractionPrompt':
      return { color: 'success' as const, label: 'Extraktion', icon: <TextSnippetIcon fontSize="small" /> };
    case 'ScoringPrompt':
      return { color: 'secondary' as const, label: 'Bewertung', icon: <LeaderboardIcon fontSize="small" /> };
    case 'DecisionPrompt':
      return { color: 'info' as const, label: 'Entscheidung', icon: <AltRouteIcon fontSize="small" /> };
  }
};

export default function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newText, setNewText] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [newJsonKey, setNewJsonKey] = useState('');
  const [newType, setNewType] = useState<PromptType>('ExtractionPrompt');

  useEffect(() => {
    if (newType === 'ExtractionPrompt') setNewWeight(1);
    else setNewJsonKey('');
  }, [newType]);

  const canCreate =
      newText.trim() !== '' &&
      (newType !== 'ExtractionPrompt' || newJsonKey.trim() !== '');

  const load = () => {
    fetch(`${getBase()}/prompts`)
    .then((r) => r.json())
    .then(setPrompts)
    .catch((e) => console.error('Prompts laden', e));
  };

  useEffect(load, []);

  const create = () => {
    fetch(`${getBase()}/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: newText,
        weight: newType === 'ExtractionPrompt' ? 1 : newWeight,
        json_key: newType === 'ExtractionPrompt' ? newJsonKey : undefined,
        type: newType,
        favorite: false,
      }),
    })
    .then(() => {
      setNewText('');
      setNewWeight(1);
      setNewJsonKey('');
      load();
    })
    .catch((e) => console.error('Prompt anlegen', e));
  };

  const save = (p: Prompt) => {
    if (p.type === 'ExtractionPrompt' && !p.json_key?.trim()) return;
    fetch(`${getBase()}/prompts/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: p.text,
        weight: p.type === 'ExtractionPrompt' ? 1 : p.weight,
        json_key: p.type === 'ExtractionPrompt' ? p.json_key : undefined,
        type: p.type,
        favorite: p.favorite,
      }),
    }).then(load);
  };

  const del = (id: number) => {
    fetch(`${getBase()}/prompts/${id}`, { method: 'DELETE' })
    .then(load)
    .catch((e) => console.error('Prompt löschen', e));
  };

  return (
      <Box>
        <PageHeader
            title="Prompts"
            subtitle="Erstellen & verwalten von Prompt-Vorlagen"
            tone="info"
            icon={<TextSnippetIcon />}
            breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Prompts' }]}
            tag={`Anzahl: ${prompts.length}`}
            actions={
              <Button
                  component="a"
                  href="https://chatgpt.com/g/g-688d63e210008191972ad48f0b844319-prompt-optimierer"
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="outlined"
              >
                Prompt-Optimierer öffnen
              </Button>
            }
        />

        {/* Neu-Formular */}
        <Card sx={{ mb: 2, borderLeft: '5px solid', borderColor: 'info.main' }}>
          <CardContent>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
              <TextField value={newText} onChange={(e) => setNewText(e.target.value)} label="Text" fullWidth />

              {/* Typ-Auswahl NUR Icons (mit Tooltip) */}
              <ToggleButtonGroup
                  exclusive
                  value={newType}
                  onChange={(_, val) => val && setNewType(val)}
                  sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}
              >
                {(['ExtractionPrompt', 'ScoringPrompt', 'DecisionPrompt'] as PromptType[]).map((t) => {
                  const meta = typeMeta(t);
                  return (
                      <Tooltip key={t} title={meta.label}>
                        <ToggleButton
                            value={t}
                            aria-label={meta.label}
                            sx={{
                              border: 1,
                              borderColor: 'divider',
                              p: 1,
                              '&.Mui-selected': {
                                bgcolor: (theme) => theme.palette[meta.color].light,
                                color: (theme) => theme.palette[meta.color].contrastText,
                                borderColor: (theme) => theme.palette[meta.color].main,
                              },
                              '&:hover': {
                                borderColor: (theme) => theme.palette[meta.color].main,
                              },
                            }}
                        >
                          {meta.icon}
                        </ToggleButton>
                      </Tooltip>
                  );
                })}
              </ToggleButtonGroup>

              {newType === 'ExtractionPrompt' ? (
                  <TextField
                      label="Name"
                      value={newJsonKey}
                      onChange={(e) => setNewJsonKey(e.target.value)}
                      sx={{ width: { xs: '100%', md: 220 } }}
                  />
              ) : (
                  <Box sx={{ width: { xs: '100%', md: 280 } }}>
                    <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
                      Gewichtung
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Slider
                          min={1}
                          max={10}
                          step={1}
                          value={newWeight}
                          onChange={(_, v) => setNewWeight(v as number)}
                          sx={{ flex: 1 }}
                      />
                      <TextField
                          type="number"
                          size="small"
                          value={newWeight}
                          onChange={(e) => setNewWeight(parseFloat(e.target.value))}
                          inputProps={{ step: 1, min: 1, max: 10 }}
                          sx={{ width: 90 }}
                      />
                    </Stack>
                  </Box>
              )}

              <Button variant="contained" disabled={!canCreate} onClick={create} startIcon={<SaveIcon />}>
                {/* kein Label – nur Icon wie gewünscht */}
              </Button>
            </Stack>
          </CardContent>
        </Card>

        {/* Liste */}
        <Stack spacing={1.25}>
          {prompts.map((p) => {
            const meta = typeMeta(p.type);
            const canSave = p.type !== 'ExtractionPrompt' || (p.json_key && p.json_key.trim().length > 0);
            return (
                <Card key={p.id} sx={{ borderLeft: '5px solid', borderColor: `${meta.color}.main` }}>
                  <CardContent>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
                      {/* Typ-Chip + Favorit */}
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 220 }}>
                        <Chip icon={meta.icon} label={meta.label} color={meta.color} size="small" />
                        <Tooltip title={p.favorite ? 'Als nicht favorisiert markieren' : 'Als Favorit markieren'}>
                          <Button
                              size="small"
                              variant={p.favorite ? 'contained' : 'outlined'}
                              color={p.favorite ? 'warning' : 'inherit'}
                              onClick={() => {
                                const next = { ...p, favorite: !p.favorite };
                                setPrompts((ps) => ps.map((it) => (it.id === p.id ? next : it)));
                                save(next);
                              }}
                              startIcon={p.favorite ? <StarIcon /> : <StarBorderIcon />}
                              sx={{ minWidth: 0, px: 1.25 }}
                          >
                            Favorit
                          </Button>
                        </Tooltip>
                      </Stack>

                      {/* Text */}
                      <TextField
                          label="Text"
                          fullWidth
                          value={p.text}
                          onChange={(e) =>
                              setPrompts((ps) => ps.map((it) => (it.id === p.id ? { ...it, text: e.target.value } : it)))
                          }
                      />

                      {/* Name / Gewichtung */}
                      {p.type === 'ExtractionPrompt' ? (
                          <TextField
                              label="Name"
                              value={p.json_key || ''}
                              onChange={(e) =>
                                  setPrompts((ps) => ps.map((it) => (it.id === p.id ? { ...it, json_key: e.target.value } : it)))
                              }
                              sx={{ width: { xs: '100%', md: 240 } }}
                              InputProps={{ startAdornment: <LabelOutlinedIcon sx={{ mr: 1 }} /> }}
                          />
                      ) : (
                          <Box sx={{ width: { xs: '100%', md: 300 } }}>
                            <Typography variant="caption" sx={{ display: 'block', mb: 0.5 }}>
                              Gewichtung
                            </Typography>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Slider
                                  min={1}
                                  max={10}
                                  step={1}
                                  value={p.weight}
                                  onChange={(_, v) =>
                                      setPrompts((ps) => ps.map((it) => (it.id === p.id ? { ...it, weight: v as number } : it)))
                                  }
                                  sx={{ flex: 1 }}
                              />
                              <TextField
                                  type="number"
                                  size="small"
                                  value={p.weight}
                                  onChange={(e) =>
                                      setPrompts((ps) =>
                                          ps.map((it) => (it.id === p.id ? { ...it, weight: parseFloat(e.target.value) } : it))
                                      )
                                  }
                                  inputProps={{ step: 1, min: 1, max: 10 }}
                                  sx={{ width: 90 }}
                              />
                            </Stack>
                          </Box>
                      )}
                    </Stack>

                    <Divider sx={{ my: 1.25 }} />

                    {/* Sekundärinfos */}
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      {p.type === 'ExtractionPrompt' && p.json_key && (
                          <Chip size="small" icon={<LabelOutlinedIcon />} label={`Name: ${p.json_key}`} variant="outlined" />
                      )}
                      <Chip size="small" label={`ID: ${p.id}`} variant="outlined" />
                    </Stack>
                  </CardContent>

                  <CardActions sx={{ justifyContent: 'flex-end', pt: 0 }}>
                    <Button onClick={() => save(p)} variant="contained" size="small" startIcon={<SaveIcon />} disabled={!canSave}>
                      {/* kein Label – nur Icon */}
                    </Button>
                    <Button onClick={() => del(p.id)} size="small" startIcon={<DeleteIcon />}>
                      {/* kein Label – nur Icon */}
                    </Button>
                  </CardActions>
                </Card>
            );
          })}
        </Stack>
      </Box>
  );
}
