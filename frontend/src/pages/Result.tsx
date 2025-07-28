import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Tabs,
  Tab,
  LinearProgress,
  Chip,
  Alert,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Skeleton,
  IconButton,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import { Document, Page, pdfjs } from 'react-pdf';
import { useParams } from 'react-router-dom';
import PageHeader from '../components/PageHeader';

pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

interface ResultData {
  pdf_id: number;
  pipeline_id: string;
  state: Record<string, any>;
  score: number | null;
  label: string | null;
}

function OverviewCard({ data }: { data: ResultData }) {
  const pctFmt = new Intl.NumberFormat('de-DE', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Typography variant="h6" gutterBottom>
        Übersicht
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="body2" sx={{ minWidth: 72 }}>
          Score {pctFmt.format(data.score)}
        </Typography>
        <LinearProgress
          variant="determinate"
          value={data.score * 100}
          sx={{ flexGrow: 1, height: 8, borderRadius: 1 }}
        />
      </Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
        {data.label && <Chip label={data.label} color="info" />}
      </Box>
    </Paper>
  );
}

function StateTable({ state }: { state: Record<string, any> }) {
  return (
    <Table size="small">
      <TableBody>
        {Object.entries(state).map(([k, v]) => (
          <TableRow key={k}>
            <TableCell>{k}</TableCell>
            <TableCell>{String(v)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}



function PdfViewer({ url }: { url: string }) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);

  const onLoad = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setPage(1);
  };

  return (
    <Paper sx={{ p: 1 }}>
      <Document file={url} onLoadSuccess={onLoad} loading={<Skeleton variant="rectangular" height={400} />}>
        <Page pageNumber={page} scale={scale} width={600} />
      </Document>
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

export default function Result() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<ResultData | null>(null);

  useEffect(() => {
    if (!id) return;
    const api = import.meta.env.VITE_HISTORY_URL || 'http://localhost:8090';
    fetch(`${api}/results/${id}`)
      .then(r => r.json())
      .then(setData)
      .catch(e => console.error('load result', e));
  }, [id]);


  const ingest = import.meta.env.VITE_INGEST_URL || 'http://localhost:8081';
  const pdfUrl = `${ingest}/pdf/${id}`;

  return (
    <Box>
      <PageHeader title="Ergebnis" breadcrumb={[{ label: 'Dashboard', to: '/' }, { label: 'Analysen', to: '/analyses' }, { label: `Result ${id}` }]} />
      {!data ? (
        <Box>
          <Skeleton variant="rectangular" height={120} sx={{ mb: 2 }} />
          <Skeleton variant="rectangular" height={400} />
        </Box>
      ) : (
        <>
          <OverviewCard data={data} />
          <StateTable state={data.state} />
          <Box sx={{ mt: 2 }}>
            <PdfViewer url={pdfUrl} />
          </Box>
        </>
      )}
    </Box>
  );
}
