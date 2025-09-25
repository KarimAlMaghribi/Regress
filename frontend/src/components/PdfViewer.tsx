import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Paper, Skeleton, IconButton, Typography, Stack } from '@mui/material';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import { Document, Page, pdfjs } from 'react-pdf';
import { TextPosition } from '../types/pipeline';

// pdf.js Worker (CDN). Für Offline/CSP ggf. auf lokale Worker-Datei umstellen.
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

type Props = {
  url: string;
  page: number;                              // <-- controlled
  onPageChange?: (page: number) => void;     // <-- meldet Page-Änderungen zurück
  onNumPages?: (n: number) => void;          // optional: um "x / y" im Header zu zeigen
  highlight?: TextPosition | null;           // { page, bbox:[x0,y0,x1,y1] } mit 0..1 Koordinaten
  mode?: 'single' | 'scroll';                // single=eine Seite, scroll=alle Seiten untereinander
  initialScale?: number;                     // Start-Zoom
  minScale?: number;
  maxScale?: number;
  showControls?: boolean;                    // Blätter-/Zoom-Buttons zeigen
  height?: number | string;                  // feste Höhe für Scroll-Container
};

export default function PdfViewer({
                                    url,
                                    page,
                                    onPageChange,
                                    onNumPages,
                                    highlight = null,
                                    mode = 'single',
                                    initialScale = 1,
                                    minScale = 0.5,
                                    maxScale = 2,
                                    showControls = true,
                                    height = '70vh',
                                  }: Props) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(initialScale);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  // Für scrollenden Modus: Wrapper-Refs je Seite + gemessene Seitengrößen
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pageSizes = useRef<Map<number, { w: number; h: number }>>(new Map());

  const clampPage = useCallback(
      (p: number) => (numPages ? Math.min(Math.max(1, p), numPages) : p),
      [numPages]
  );

  const handleLoadSuccess = useCallback(
      ({ numPages: n }: { numPages: number }) => {
        setNumPages(n);
        onNumPages?.(n);
        // Falls page außerhalb Range:
        if (onPageChange) onPageChange(clampPage(page || 1));
      },
      [onNumPages, onPageChange, page, clampPage]
  );

  // Containerbreite beobachten (responsive Page width)
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(containerRef.current!.clientWidth);
    });
    setContainerWidth(containerRef.current.clientWidth);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Scrollender Modus: beim Prop-Wechsel zur Seite springen
  useEffect(() => {
    if (mode !== 'scroll') return;
    const target = pageRefs.current.get(page);
    if (target && containerRef.current) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [page, mode]);

  // Scrollender Modus: sichtbare Seite erkennen
  useEffect(() => {
    if (mode !== 'scroll' || !onPageChange || !containerRef.current) return;
    const root = containerRef.current;
    const io = new IntersectionObserver(
        (entries) => {
          // nimm die Seite mit größter Sichtbarkeit
          const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
          if (!visible) return;
          const pg = Number((visible.target as HTMLElement).dataset.pg);
          if (pg && pg !== page) onPageChange(pg);
        },
        { root, threshold: [0.3, 0.6, 0.9] }
    );
    pageRefs.current.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [mode, onPageChange, page, numPages]);

  const pageWidth = useMemo(() => {
    if (!containerWidth) return 600; // Fallback
    return Math.max(200, Math.floor(containerWidth * scale));
  }, [containerWidth, scale]);

  // Helper zum Rendern einer einzelnen Seite inkl. optionalem Highlight-Overlay
  const renderPage = (pg: number) => {
    const isCurrent = pg === page;
    const wrapperRef = (el: HTMLDivElement | null) => {
      if (!el) {
        pageRefs.current.delete(pg);
      } else {
        pageRefs.current.set(pg, el);
      }
    };

    const onRenderSuccess = () => {
      const el = pageRefs.current.get(pg);
      const canvas = el?.querySelector('canvas') as HTMLCanvasElement | null;
      if (canvas) {
        pageSizes.current.set(pg, { w: canvas.clientWidth, h: canvas.clientHeight });
      }
    };

    // Overlay nur auf der Seite rendern, zu der das Highlight gehört
    const size = pageSizes.current.get(pg);
    const showHl = highlight && highlight.page === pg && size;

    return (
        <div
            key={pg}
            ref={wrapperRef}
            data-pg={pg}
            style={{
              position: 'relative',
              margin: '0 auto',
              padding: mode === 'scroll' ? '8px 0' : 0,
              scrollMarginTop: 16,
              width: pageWidth,
            }}
        >
          <Page
              pageNumber={pg}
              width={pageWidth}
              onRenderSuccess={onRenderSuccess}
              loading={<Skeleton variant="rectangular" height={400} />}
          />
          {showHl && (
              <Box
                  sx={{
                    position: 'absolute',
                    pointerEvents: 'none',
                    border: '2px solid red',
                    left: (highlight!.bbox[0]) * size!.w,
                    top: (highlight!.bbox[1]) * size!.h,
                    width: (highlight!.bbox[2] - highlight!.bbox[0]) * size!.w,
                    height: (highlight!.bbox[3] - highlight!.bbox[1]) * size!.h,
                  }}
              />
          )}
          {/* optional: aktuelle Seite hervorheben */}
          {mode === 'scroll' && (
              <Box sx={{ position: 'absolute', top: 4, right: 8, bgcolor: 'rgba(0,0,0,0.5)', color: 'white', px: 0.75, py: 0.25, borderRadius: 1, fontSize: 12 }}>
                {pg}/{numPages || '…'}
              </Box>
          )}
        </div>
    );
  };

  const canPrev = page > 1;
  const canNext = numPages ? page < numPages : false;

  return (
      <Paper sx={{ p: 1, height, display: 'flex', flexDirection: 'column' }}>
        <Box
            ref={containerRef}
            sx={{
              position: 'relative',
              flex: 1,
              overflow: 'auto',
              display: 'flex',
              justifyContent: 'center',
            }}
            tabIndex={0}
            onKeyDown={(e) => {
              if (!onPageChange) return;
              if (e.key === 'ArrowLeft') onPageChange(clampPage(page - 1));
              if (e.key === 'ArrowRight') onPageChange(clampPage(page + 1));
            }}
        >
          <Document file={url} onLoadSuccess={handleLoadSuccess} loading={<Skeleton variant="rectangular" height="100%" />}>
            {mode === 'single'
                ? renderPage(clampPage(page || 1))
                : Array.from({ length: numPages || 0 }, (_, i) => renderPage(i + 1))}
          </Document>
        </Box>

        {showControls && (
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 1 }}>
              <Box>
                <IconButton size="small" onClick={() => onPageChange?.(clampPage(page - 1))} disabled={!canPrev}>
                  <NavigateBeforeIcon />
                </IconButton>
                <IconButton size="small" onClick={() => onPageChange?.(clampPage(page + 1))} disabled={!canNext}>
                  <NavigateNextIcon />
                </IconButton>
                <Typography variant="caption" sx={{ ml: 1 }}>
                  {page} / {numPages || '–'}
                </Typography>
              </Box>
              <Box>
                <IconButton size="small" onClick={() => setScale((s) => Math.max(minScale, +(s - 0.1).toFixed(2)))}>
                  <ZoomOutIcon />
                </IconButton>
                <IconButton size="small" onClick={() => setScale((s) => Math.min(maxScale, +(s + 0.1).toFixed(2)))}>
                  <ZoomInIcon />
                </IconButton>
              </Box>
            </Stack>
        )}
      </Paper>
  );
}
