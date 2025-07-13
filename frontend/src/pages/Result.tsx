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

interface Response { answer: string; source?: string }
interface Rule { prompt: string; result: boolean; weight?: number }

interface ResultData {
  regress: boolean | null;
  metrics: { rules: Rule[]; [key: string]: any };
  responses: Response[];
  error: string | null;
  score: number;
  result_label: string;
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
        <Chip
          label={data.result_label}
          color={data.result_label === 'KEIN_REGRESS' ? 'success' : 'error'}
        />
        <Chip
          label={`Regress: ${data.regress ? 'Ja' : 'Nein'}`}
          color={data.regress ? 'error' : 'success'}
        />
      </Box>
      {data.error && <Alert severity="error">{data.error}</Alert>}
    </Paper>
  );
}

function ResponsesList({ responses }: { responses: Response[] }) {
  if (!responses.length) return <Typography>Keine Antworten</Typography>;
  return (
    <Box>
      {responses.map((r, i) => (
        <Accordion key={i}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography noWrap>{r.answer}</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography sx={{ whiteSpace: 'pre-wrap', mb: 0.5 }}>
              {r.answer}
            </Typography>
            {r.source && (
              <Typography variant="caption" display="block">
                Quelle: {r.source}
              </Typography>
            )}
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}

function MetricsTable({ rules }: { rules: Rule[] }) {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Prompt</TableCell>
          <TableCell align="center">Ergebnis</TableCell>
          <TableCell align="right">Gewicht</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rules.map((r, i) => (
          <TableRow key={i}>
            <TableCell>{r.prompt}</TableCell>
            <TableCell align="center">
              {r.result ? (
                <CheckIcon color="success" fontSize="small" />
              ) : (
                <CloseIcon color="error" fontSize="small" />
              )}
            </TableCell>
            <TableCell align="right">
              {r.weight != null ? r.weight.toFixed(2) : '-'}
            </TableCell>
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
  const [tab, setTab] = useState(0);

  useEffect(() => {
    if (!id) return;
    const backend = import.meta.env.VITE_CLASSIFIER_URL || 'http://localhost:8084';
    fetch(`${backend}/results/${id}`)
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
          <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
            <Tab label="Antworten" />
            <Tab label="Metriken" />
          </Tabs>
          {tab === 0 && <ResponsesList responses={data.responses} />}
          {tab === 1 && <MetricsTable rules={data.metrics.rules || []} />}
          <Box sx={{ mt: 2 }}>
            <PdfViewer url={pdfUrl} />
          </Box>
        </>
      )}
    </Box>
  );
}
