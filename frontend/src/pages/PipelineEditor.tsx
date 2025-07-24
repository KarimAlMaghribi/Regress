import React, { useEffect } from 'react';
import { Box, Button, Typography } from '@mui/material';
import StageLanesBoard from '../components/pipeline/StageLanesBoard';
import { usePipelineStore } from '../store/usePipelineStore';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';

export default function PipelineEditor() {
  const [params] = useSearchParams();
  const pdfId = params.get('pdf');
  const { validationErrors } = usePipelineStore();

  /* beim ersten Mount automatisch leeren Store validieren – sonst Warnungen */
  useEffect(() => {
    usePipelineStore.getState().validate();
  }, []);

  const handleSave = () => {
    if (validationErrors.length) {
      toast.error('Pipeline enthält Fehler – bitte korrigieren');
      return;
    }
    toast.success('💾 Pipeline gespeichert (Demo – API folgt)');
    // TODO: POST /pipelines
  };

  return (
      <Box sx={{ p: 2 }}>
        {pdfId && (
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              📄 Verbundenes PDF: {pdfId}
            </Typography>
        )}

        {/* Haupt‑Board */}
        <StageLanesBoard />

        {/* Footer | Save‑Button */}
        <Box sx={{ mt: 2 }}>
          <Button
              variant="contained"
              disabled={!!validationErrors.length}
              onClick={handleSave}
          >
            💾 Speichern
          </Button>
          {!!validationErrors.length && (
              <Typography color="error" sx={{ ml: 2 }} component="span">
                {validationErrors.length} Fehler
              </Typography>
          )}
        </Box>
      </Box>
  );
}
