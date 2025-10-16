import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import PipelineEditor from '../components/PipelineEditor';
import { usePipelineStore } from '../hooks/usePipelineStore';
import { Alert, Button, Paper, Stack } from '@mui/material';
import PageHeader from '../components/PageHeader';
import BuildIcon from '@mui/icons-material/Build';

export default function PipelinePage() {
  const { id } = useParams();
  const { loadPipeline, name, currentPipelineId } = usePipelineStore();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    loadPipeline(id).catch(e => setError(String(e)));
  }, [id, loadPipeline]);

  return (
      <Stack spacing={4}>
        <PageHeader
            title={name || 'Pipeline bearbeiten'}
            subtitle="Abläufe konfigurieren, Anweisungen feintunen und Freigaben steuern"
            breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Pipeline', to: '/pipeline' }, { label: id ?? 'Neu' }]}
            tone="primary"
            icon={<BuildIcon />}
            tag={currentPipelineId ? `ID: ${currentPipelineId}` : 'Neue Pipeline'}
            actions={
              <Button component={Link} to="/pipeline" variant="outlined" size="small">
                Zur Übersicht
              </Button>
            }
        />

        {error ? (
            <Paper
                variant="outlined"
                sx={{
                  p: { xs: 3, md: 4 },
                  borderRadius: 'var(--radius-card)',
                  boxShadow: 'var(--shadow-z1)',
                }}
            >
              <Alert severity="error">Fehler beim Laden der Pipeline: {error}</Alert>
            </Paper>
        ) : (
            <Paper
                variant="outlined"
                sx={{
                  p: { xs: 2, md: 3 },
                  borderRadius: 'var(--radius-card)',
                  boxShadow: 'var(--shadow-z1)',
                }}
            >
              <PipelineEditor />
            </Paper>
        )}
      </Stack>
  );
}
