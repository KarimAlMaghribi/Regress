import React, { useState, useEffect } from 'react';
import { Box, Button, LinearProgress, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import DropZone from '../components/DropZone';
import DocumentPreview from '../components/DocumentPreview';

interface LayoutPage {
  width: number;
  height: number;
  blocks: { bbox: [number, number, number, number]; text: string }[];
}
interface Layout { pages: LayoutPage[] }

export default function Upload() {
  const [uploadId, setUploadId] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('');
  const [layout, setLayout] = useState<Layout | null>(null);
  const navigate = useNavigate();
  const ingest = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';

  const handleFile = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${ingest}/upload`, { method: 'POST', body: form });
    const data = await res.json();
    setUploadId(Number(data.id));
    setStatus('uploading');
  };

  useEffect(() => {
    if (!uploadId) return;
    let int: NodeJS.Timer;
    const poll = async () => {
      const res = await fetch(`${ingest}/uploads/${uploadId}/status`);
      const d = await res.json();
      setStatus(d.status);
      if (d.status === 'ocr_done') {
        clearInterval(int);
        const layoutRes = await fetch(`${ingest}/pdf/${uploadId}/layout`);
        const lay = await layoutRes.json();
        setLayout(lay);
      }
    };
    poll();
    int = setInterval(poll, 2000);
    return () => clearInterval(int);
  }, [uploadId]);

  return (
    <Box>
      {!uploadId && <DropZone onUpload={handleFile} />}
      {uploadId && status !== 'ocr_done' && (
        <Box sx={{ mt: 4 }}>
          <LinearProgress />
          <Typography sx={{ mt: 1 }}>🔄 OCR läuft…</Typography>
        </Box>
      )}
      {layout && uploadId && (
        <Box sx={{ mt: 2 }}>
          <DocumentPreview pdfUrl={`${ingest}/pdf/${uploadId}`} page={layout.pages[0]} />
          <Button variant="contained" sx={{ mt: 2 }} onClick={() => navigate(`/analyse?id=${uploadId}`)}>
            ➡️ Pipeline starten
          </Button>
        </Box>
      )}
    </Box>
  );
}
