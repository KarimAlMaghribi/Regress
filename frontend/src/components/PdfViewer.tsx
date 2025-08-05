import React, { useEffect, useRef, useState } from 'react';
import { Box, Paper, Skeleton, IconButton, Typography } from '@mui/material';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import { Document, Page, pdfjs } from 'react-pdf';
import { TextPosition } from '../types/pipeline';

pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

export default function PdfViewer({ url, highlight }: { url: string; highlight: TextPosition | null }) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const onLoad = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setPage(1);
  };

  useEffect(() => {
    if (highlight) {
      setPage(highlight.page);
    }
  }, [highlight]);

  useEffect(() => {
    const canvas = containerRef.current?.querySelector('canvas');
    if (canvas) {
      setDims({ w: canvas.clientWidth, h: canvas.clientHeight });
    }
  }, [page, scale]);

  return (
    <Paper sx={{ p: 1 }}>
      <div ref={containerRef} style={{ position: 'relative' }}>
        <Document file={url} onLoadSuccess={onLoad} loading={<Skeleton variant="rectangular" height={400} />}>
          <Page pageNumber={page} scale={scale} width={600} />
        </Document>
        {highlight && dims && highlight.page === page && (
          <Box
            sx={{
              position: 'absolute',
              border: '2px solid red',
              left: highlight.bbox[0] * dims.w,
              top: highlight.bbox[1] * dims.h,
              width: (highlight.bbox[2] - highlight.bbox[0]) * dims.w,
              height: (highlight.bbox[3] - highlight.bbox[1]) * dims.h,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <IconButton size="small" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
            <NavigateBeforeIcon />
          </IconButton>
          <IconButton size="small" onClick={() => setPage(p => Math.min(numPages, p + 1))} disabled={page >= numPages}>
            <NavigateNextIcon />
          </IconButton>
          <Typography variant="caption" sx={{ ml: 1 }}>
            {page} / {numPages}
          </Typography>
        </Box>
        <Box>
          <IconButton size="small" onClick={() => setScale(s => Math.max(0.5, +(s - 0.1).toFixed(2)))}>
            <ZoomOutIcon />
          </IconButton>
          <IconButton size="small" onClick={() => setScale(s => Math.min(2, +(s + 0.1).toFixed(2)))}>
            <ZoomInIcon />
          </IconButton>
        </Box>
      </Box>
    </Paper>
  );
}
