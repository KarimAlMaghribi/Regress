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
  Paper,
  Collapse,
  Alert,
  CircularProgress,
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
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { alpha, useTheme } from '@mui/material/styles';
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

type ReviewScoreLabel = 'excellent' | 'good' | 'fair' | 'poor';
type ReviewIssueSeverity = 'low' | 'medium' | 'high';

interface PromptReviewScore {
  value: number;
  label: ReviewScoreLabel;
}

interface PromptReviewIssue {
  area: string;
  severity: ReviewIssueSeverity;
  detail: string;
}

interface PromptReviewResult {
  score: PromptReviewScore;
  strengths: string[];
  issues: PromptReviewIssue[];
  guardrails: string[];
  suggested_prompt: string;
  notes: string[];
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

// Meta-Information für die Darstellung der Prompt-Typen
const typeMeta = (t: PromptType) => {
  switch (t) {
    case 'ExtractionPrompt':
      return { label: 'Extraktion', icon: <TextSnippetIcon fontSize="small" /> };
    case 'ScoringPrompt':
      return { label: 'Bewertung', icon: <LeaderboardIcon fontSize="small" /> };
    case 'DecisionPrompt':
      return { label: 'Entscheidung', icon: <AltRouteIcon fontSize="small" /> };
  }
};

export default function Prompts() {
  const theme = useTheme();
  const accent = {
    border: alpha(theme.palette.primary.main, 0.18),
    subtleBorder: alpha(theme.palette.primary.main, 0.08),
    background: alpha(theme.palette.primary.main, 0.06),
    strong: theme.palette.primary.main,
  };
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [newText, setNewText] = useState('');
  const [newWeight, setNewWeight] = useState(1);
  const [newJsonKey, setNewJsonKey] = useState('');
  const [newType, setNewType] = useState<PromptType>('ExtractionPrompt');
  const [reviewById, setReviewById] = useState<Record<number, PromptReviewResult | undefined>>({});
  const [reviewErrors, setReviewErrors] = useState<Record<number, string | undefined>>({});
  const [loadingReviewId, setLoadingReviewId] = useState<number | null>(null);

  const scoreLabelMap: Record<ReviewScoreLabel, string> = {
    excellent: 'Exzellent',
    good: 'Gut',
    fair: 'Durchschnittlich',
    poor: 'Verbesserungswürdig',
  };
  const scoreColorMap: Record<ReviewScoreLabel, 'success' | 'info' | 'warning' | 'error'> = {
    excellent: 'success',
    good: 'info',
    fair: 'warning',
    poor: 'error',
  };
  const issueSeverityColor: Record<ReviewIssueSeverity, 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
  };
  const issueSeverityLabel: Record<ReviewIssueSeverity, string> = {
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
  };

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
    .then((data: Prompt[]) => {
      setPrompts(data);
      setReviewById({});
      setReviewErrors({});
    })
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

  const reviewPrompt = (id: number) => {
    setLoadingReviewId(id);
    setReviewErrors((prev) => ({ ...prev, [id]: undefined }));
    fetch(`${getBase()}/prompts/${id}/evaluate`, { method: 'POST' })
    .then(async (res) => {
      if (!res.ok) {
        let message = `Bewertung fehlgeschlagen (${res.status})`;
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch (err) {
          console.warn('Fehlerantwort konnte nicht gelesen werden', err);
        }
        throw new Error(message);
      }
      return res.json();
    })
    .then((data: PromptReviewResult) => {
      setReviewById((prev) => ({ ...prev, [id]: data }));
    })
    .catch((err: Error) => {
      setReviewErrors((prev) => ({ ...prev, [id]: err.message }));
    })
    .finally(() => {
      setLoadingReviewId((prev) => (prev === id ? null : prev));
    });
  };

  const adoptSuggestion = (id: number) => {
    const suggestion = reviewById[id]?.suggested_prompt;
    if (!suggestion) return;
    setPrompts((items) =>
        items.map((it) => (it.id === id ? { ...it, text: suggestion } : it))
    );
  };

  return (
      <Stack spacing={4}>
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

        <Paper
            variant="outlined"
            sx={{
              p: { xs: 3, md: 4 },
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-z1)',
              background:
                  theme.palette.mode === 'dark'
                      ? alpha(theme.palette.primary.main, 0.12)
                      : 'linear-gradient(130deg, rgba(0,110,199,0.08), rgba(247,250,252,0.92))',
            }}
        >
          <Stack spacing={2}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Governance & Bibliothek
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Strukturierte Verwaltung aller Prompt-Artefakte – inklusive Favoriten, Typ-spezifischer Einstellungen
              und Direktzugriff auf Optimierungstools.
            </Typography>
          </Stack>
        </Paper>

        {/* Neu-Formular */}
        <Card
            variant="outlined"
            sx={{
              borderRadius: 'var(--radius-card)',
              borderColor: accent.border,
              boxShadow: 'var(--shadow-z1)',
              background: `linear-gradient(135deg, ${alpha(theme.palette.background.paper, 0.97)}, ${alpha(theme.palette.background.paper, 0.9)})`,
            }}
        >
          <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                Neuen Prompt anlegen
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Definiere Text, Typ und optional eine Gewichtung oder einen Namen für Extraktionen.
              </Typography>
            </Box>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2.5} alignItems={{ md: 'center' }}>
              <TextField value={newText} onChange={(e) => setNewText(e.target.value)} label="Text" fullWidth size="small" />

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
                              borderColor: accent.subtleBorder,
                              p: 1,
                              bgcolor: 'background.paper',
                              '&.Mui-selected': {
                                bgcolor: accent.background,
                                color: accent.strong,
                                borderColor: accent.border,
                              },
                              '&:hover': {
                                borderColor: accent.border,
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
                      size="small"
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
                          sx={{ flex: 1, color: accent.strong }}
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

              <Button variant="contained" disabled={!canCreate} onClick={create} startIcon={<SaveIcon />} sx={{ borderRadius: 2 }}>
                {/* kein Label – nur Icon wie gewünscht */}
              </Button>
            </Stack>
          </CardContent>
        </Card>

        {/* Liste */}
        <Stack spacing={2}>
          {prompts.map((p) => {
            const meta = typeMeta(p.type);
            const canSave = p.type !== 'ExtractionPrompt' || (p.json_key && p.json_key.trim().length > 0);
            const review = reviewById[p.id];
            const reviewError = reviewErrors[p.id];
            const isReviewLoading = loadingReviewId === p.id;
            return (
                <Card
                    key={p.id}
                    variant="outlined"
                    sx={{
                      borderRadius: 'var(--radius-card)',
                      borderColor: accent.border,
                      boxShadow: 'var(--shadow-z1)',
                      backgroundColor: alpha(theme.palette.background.paper, 0.98),
                    }}
                >
                  <CardContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2.5} alignItems={{ md: 'center' }}>
                      {/* Typ-Chip + Favorit */}
                      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 220 }}>
                        <Box
                            sx={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 1,
                              px: 1.25,
                              py: 0.6,
                              borderRadius: 999,
                              bgcolor: accent.background,
                              color: accent.strong,
                              border: `1px solid ${accent.border}`,
                            }}
                        >
                          {meta.icon}
                          <Typography variant="body2" fontWeight={600}>
                            {meta.label}
                          </Typography>
                        </Box>
                        <Tooltip title={p.favorite ? 'Als nicht favorisiert markieren' : 'Als Favorit markieren'}>
                          <Button
                              size="small"
                              variant={p.favorite ? 'contained' : 'outlined'}
                              color={p.favorite ? 'primary' : 'inherit'}
                              onClick={() => {
                                const next = { ...p, favorite: !p.favorite };
                                setPrompts((ps) => ps.map((it) => (it.id === p.id ? next : it)));
                                save(next);
                              }}
                              startIcon={p.favorite ? <StarIcon /> : <StarBorderIcon />}
                              sx={{ minWidth: 0, px: 1.25, borderRadius: 2 }}
                          >
                            Favorit
                          </Button>
                        </Tooltip>
                      </Stack>

                      {/* Text */}
                      <TextField
                          label="Text"
                          fullWidth
                          size="small"
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
                              size="small"
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
                                  sx={{ flex: 1, color: accent.strong }}
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

                    <Divider sx={{ my: 1 }} />

                    {/* Sekundärinfos */}
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      {p.type === 'ExtractionPrompt' && p.json_key && (
                          <Chip
                              size="small"
                              icon={<LabelOutlinedIcon />}
                              label={`Name: ${p.json_key}`}
                              variant="outlined"
                              sx={{ borderRadius: 2 }}
                          />
                      )}
                      <Chip size="small" label={`ID: ${p.id}`} variant="outlined" sx={{ borderRadius: 2 }} />
                    </Stack>

                    {reviewError && (
                        <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>
                          {reviewError}
                        </Alert>
                    )}

                    <Collapse in={Boolean(review)} unmountOnExit>
                      {review && (
                          <Box
                              sx={{
                                mt: 2,
                                borderRadius: 2,
                                border: `1px solid ${accent.subtleBorder}`,
                                background: alpha(
                                    theme.palette.primary.main,
                                    theme.palette.mode === 'dark' ? 0.12 : 0.06
                                ),
                                p: 2,
                              }}
                          >
                            <Stack spacing={1.5}>
                              <Stack
                                  direction={{ xs: 'column', sm: 'row' }}
                                  spacing={1.5}
                                  alignItems={{ sm: 'center' }}
                                  justifyContent="space-between"
                              >
                                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                                    LLM-Review
                                  </Typography>
                                  <Chip
                                      size="small"
                                      color={scoreColorMap[review.score.label]}
                                      label={`${review.score.value}/100 · ${scoreLabelMap[review.score.label]}`}
                                      sx={{ borderRadius: 2 }}
                                  />
                                </Stack>
                                <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={() => adoptSuggestion(p.id)}
                                    disabled={!review.suggested_prompt.trim()}
                                    sx={{ borderRadius: 2 }}
                                >
                                  Vorschlag übernehmen
                                </Button>
                              </Stack>

                              {review.suggested_prompt && (
                                  <Paper
                                      variant="outlined"
                                      sx={{
                                        borderRadius: 2,
                                        p: 1.5,
                                        bgcolor: alpha(
                                            theme.palette.background.paper,
                                            theme.palette.mode === 'dark' ? 0.35 : 0.6
                                        ),
                                      }}
                                  >
                                    <Typography
                                        component="pre"
                                        sx={{
                                          m: 0,
                                          whiteSpace: 'pre-wrap',
                                          fontFamily: 'var(--font-mono)',
                                          fontSize: '0.85rem',
                                        }}
                                    >
                                      {review.suggested_prompt}
                                    </Typography>
                                  </Paper>
                              )}

                              {review.strengths?.length ? (
                                  <Box>
                                    <Typography variant="caption" color="text.secondary">
                                      Stärken
                                    </Typography>
                                    <Stack spacing={0.5} mt={0.5}>
                                      {review.strengths.map((item, idx) => (
                                          <Typography key={`strength-${idx}`} variant="body2">
                                            • {item}
                                          </Typography>
                                      ))}
                                    </Stack>
                                  </Box>
                              ) : null}

                              {review.issues?.length ? (
                                  <Box>
                                    <Typography variant="caption" color="text.secondary">
                                      Risiken &amp; Lücken
                                    </Typography>
                                    <Stack spacing={1} mt={0.5}>
                                      {review.issues.map((issue, idx) => (
                                          <Paper key={`issue-${idx}`} variant="outlined" sx={{ borderRadius: 2, p: 1.25 }}>
                                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                                              <Chip size="small" variant="outlined" label={issue.area} sx={{ borderRadius: 2 }} />
                                              <Chip
                                                  size="small"
                                                  color={issueSeverityColor[issue.severity]}
                                                  label={issueSeverityLabel[issue.severity]}
                                                  sx={{ borderRadius: 2 }}
                                              />
                                            </Stack>
                                            <Typography variant="body2" sx={{ mt: 0.75 }}>
                                              {issue.detail}
                                            </Typography>
                                          </Paper>
                                      ))}
                                    </Stack>
                                  </Box>
                              ) : null}

                              {review.guardrails?.length ? (
                                  <Box>
                                    <Typography variant="caption" color="text.secondary">
                                      Guardrails
                                    </Typography>
                                    <Stack spacing={0.5} mt={0.5}>
                                      {review.guardrails.map((item, idx) => (
                                          <Typography key={`guardrail-${idx}`} variant="body2">
                                            • {item}
                                          </Typography>
                                      ))}
                                    </Stack>
                                  </Box>
                              ) : null}

                              {review.notes?.length ? (
                                  <Box>
                                    <Typography variant="caption" color="text.secondary">
                                      Notizen
                                    </Typography>
                                    <Stack spacing={0.5} mt={0.5}>
                                      {review.notes.map((item, idx) => (
                                          <Typography key={`note-${idx}`} variant="body2" color="text.secondary">
                                            • {item}
                                          </Typography>
                                      ))}
                                    </Stack>
                                  </Box>
                              ) : null}
                            </Stack>
                          </Box>
                      )}
                    </Collapse>
                  </CardContent>

                  <CardActions sx={{ justifyContent: 'flex-end', pt: 0, gap: 1 }}>
                    <Tooltip title="Verbesserung vorschlagen">
                      <span>
                        <Button
                            onClick={() => reviewPrompt(p.id)}
                            variant="outlined"
                            size="small"
                            startIcon={
                              isReviewLoading ? (
                                  <CircularProgress color="inherit" size={16} />
                              ) : (
                                  <AutoFixHighIcon />
                              )
                            }
                            disabled={isReviewLoading}
                            sx={{ borderRadius: 2 }}
                        >
                          {/* kein Label – nur Icon */}
                        </Button>
                      </span>
                    </Tooltip>
                    <Button onClick={() => save(p)} variant="contained" size="small" startIcon={<SaveIcon />} disabled={!canSave} sx={{ borderRadius: 2 }}>
                      {/* kein Label – nur Icon */}
                    </Button>
                    <Button onClick={() => del(p.id)} size="small" startIcon={<DeleteIcon />} sx={{ borderRadius: 2 }}>
                      {/* kein Label – nur Icon */}
                    </Button>
                  </CardActions>
                </Card>
            );
          })}
          {!prompts.length && (
              <Paper
                  variant="outlined"
                  sx={{
                    borderRadius: 'var(--radius-card)',
                    p: { xs: 3, md: 4 },
                    textAlign: 'center',
                    color: 'text.secondary',
                  }}
              >
                <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                  Noch keine Prompts vorhanden
                </Typography>
                <Typography variant="body2">
                  Lege über das Formular oben eine neue Vorlage an und starte mit der kuratierten Bibliothek.
                </Typography>
              </Paper>
          )}
        </Stack>
      </Stack>
  );
}
