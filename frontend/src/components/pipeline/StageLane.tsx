/* --------------------------------------------------------------------------
 *  StageLane – eine Spalte im Pipeline‑Editor
 *  --------------------------------------------------------------------------
 *  • Zeigt alle PromptNodes eines gegebenen PromptType
 *  • Greift auf den globalen Zustand via usePipelineStore()
 *  • Add‑Button legt sofort eine neue Karte an (nur Dummy‑Text)
 *  • TODO: Drag‑&‑Drop‑Reihenfolge mit @dnd‑kit (siehe Kommentar unten)
 * ------------------------------------------------------------------------ */

import React from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Stack,
  Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';

import { usePipelineStore } from '@/store/usePipelineStore';
import type { PromptType, UUID } from '@/types/pipeline';

interface StageLaneProps {
  promptType: PromptType;
  title?: string;
  /** Farbakzent für die Lane – z. B. '#90caf9' */
  accentColor?: string;
}

export default function StageLane({
                                    promptType,
                                    title,
                                    accentColor = '#e0e0e0',
                                  }: StageLaneProps) {
  const nodes = usePipelineStore(s =>
      s.pipeline.nodes.filter(n => n.type === promptType),
  );
  const addNode = usePipelineStore(s => s.addNode);
  const removeNode = usePipelineStore(s => s.removeNode);

  const createCard = () =>
      addNode({
        text: 'Neuer Prompt',
        type: promptType,
      } as any); // type cast, Weight / Conf‑Threshold optional

  return (
      <Paper
          elevation={3}
          sx={{
            p: 1,
            width: 260,
            minHeight: 400,
            bgcolor: accentColor,
            display: 'flex',
            flexDirection: 'column',
          }}
      >
        {/* Lane‑Header --------------------------------------------------- */}
        <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              mb: 1,
            }}
        >
          <Typography variant="subtitle2">
            {title ?? promptType.replace(/Prompt$/, '')}
          </Typography>
          <Tooltip title="Prompt hinzufügen">
            <IconButton size="small" onClick={createCard}>
              <AddIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Karten‑Liste -------------------------------------------------- */}
        <Stack spacing={1} sx={{ flexGrow: 1, overflowY: 'auto' }}>
          {nodes.map(n => (
              <PromptCard
                  key={n.id}
                  id={n.id}
                  label={n.text}
                  onDelete={() => removeNode(n.id)}
              />
          ))}
        </Stack>
      </Paper>
  );
}

/* --------------------------------------------------------------------
 *  Interne Mini‑Komponente "PromptCard"
 *  – Kann später in eine eigene Datei wandern.
 *  – Drag‑&‑Drop‑Props folgen, sobald dnd‑kit eingebunden ist.
 * ------------------------------------------------------------------ */
interface PromptCardProps {
  id: UUID;
  label: string;
  onDelete: () => void;
}

function PromptCard({ label, onDelete }: PromptCardProps) {
  return (
      <Paper
          sx={{
            p: 1,
            bgcolor: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
      >
        <Typography
            variant="body2"
            sx={{
              flexGrow: 1,
              mr: 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
        >
          {label}
        </Typography>
        <IconButton size="small" onClick={onDelete}>
          <DeleteIcon fontSize="inherit" />
        </IconButton>
      </Paper>
  );
}

/* --------------------------------------------------------------------
 *  🔜 Next Step – Drag‑&‑Drop
 *  -------------------------------------------------------------------
 *  – Installiere  @dnd-kit/core  @dnd-kit/sortable  @dnd-kit/modifiers
 *    und ersetze <Stack> durch <SortableContext>.
 *  – Das State‑Store braucht dafür eine moveNode‑/reorderNodes‑Action.
 *  – Ich liefere dir dann den kompletten Code‑Patch, sobald du dnd‑kit
 *    in package.json hast.
 * ------------------------------------------------------------------ */
