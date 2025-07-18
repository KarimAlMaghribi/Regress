import React from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Box, Tooltip } from '@mui/material';
import { motion } from 'framer-motion';

pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

interface Block { bbox: [number, number, number, number]; text: string; }
interface PageData { width: number; height: number; blocks: Block[]; }

export default function DocumentPreview({ pdfUrl, page }: { pdfUrl: string; page: PageData }) {
  return (
    <Box sx={{ position: 'relative', width: page.width, height: page.height }}>
      <Document file={pdfUrl} loading={null}>
        <Page pageNumber={1} width={page.width} />
      </Document>
      {page.blocks.map((b, i) => (
        <Tooltip key={i} title={b.text.trim().slice(0, 120)}>
          <Box
            component={motion.div}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            sx={{
              position: 'absolute',
              border: '2px solid rgba(255,0,0,0.5)',
              left: b.bbox[0],
              top: b.bbox[1],
              width: b.bbox[2] - b.bbox[0],
              height: b.bbox[3] - b.bbox[1],
              pointerEvents: 'auto',
            }}
          />
        </Tooltip>
      ))}
    </Box>
  );
}
