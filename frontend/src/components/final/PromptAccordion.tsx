import * as React from "react";
import {
  Accordion, AccordionSummary, AccordionDetails,
  Typography, Table, TableHead, TableRow, TableCell, TableBody, Chip
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { fmtVal } from "./finalUtils";

type SourcePos = { page?: number; bbox?: number[]; quote?: string };

export type ExtractionItem = {
  prompt_id: number;
  prompt_text: string;
  value?: any;
  error?: string | null;
  source?: SourcePos;
};

export type ScoringItem = {
  prompt_id: number;
  result: boolean;
  explanation?: string;
  source: SourcePos;
};

export type DecisionItem = {
  prompt_id: number;
  prompt_text: string;
  value?: any; // ggf. explanation in value.explanation
  route?: string | null;
  boolean?: boolean | null;
  source?: SourcePos;
  error?: string | null;
};

function groupByPid<T extends { prompt_id: number }>(arr: T[]) {
  return arr.reduce<Record<number, T[]>>((acc, cur) => {
    (acc[cur.prompt_id] ||= []).push(cur);
    return acc;
  }, {});
}

/** Extraction-Accordion mit Final-Header + Evidenz-Tabelle */
export function ExtractionPromptAccordion({
                                            finalMap,
                                            items,
                                            onJumpToPage,
                                          }: {
  finalMap?: Record<string, any>;
  items: ExtractionItem[];
  onJumpToPage?: (page: number) => void;
}) {
  const byPid = groupByPid(items || []);
  return (
      <>
        {Object.entries(byPid).map(([pid, list]) => {
          const finalKey = Object.keys(finalMap || {}).find((k) => k.endsWith(`_${pid}`));
          const fin = finalKey ? finalMap?.[finalKey] : undefined;
          const header = list[0]?.prompt_text ?? `Prompt #${pid}`;
          return (
              <Accordion key={pid} defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography sx={{ flex: 1 }}>
                    Extraction #{pid}: <b>{header}</b>
                  </Typography>
                  {fin && (
                      <Chip
                          size="small"
                          label={`Final: ${fmtVal(fin.value)} (${(fin.confidence ?? 0).toFixed(2)})`}
                          sx={{ ml: 1 }}
                      />
                  )}
                </AccordionSummary>
                <AccordionDetails>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Seite</TableCell>
                        <TableCell>Quote</TableCell>
                        <TableCell>Value</TableCell>
                        <TableCell>Fehler</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {list.map((r, i) => (
                          <TableRow
                              key={i}
                              hover
                              onClick={() => r.source?.page != null && onJumpToPage?.(r.source.page!)}
                              sx={{ cursor: r.source?.page != null ? "pointer" : "default" }}
                          >
                            <TableCell>{r.source?.page ?? "—"}</TableCell>
                            <TableCell>{r.source?.quote ?? "—"}</TableCell>
                            <TableCell>{fmtVal(r.value)}</TableCell>
                            <TableCell>{r.error ?? ""}</TableCell>
                          </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
          );
        })}
      </>
  );
}

/** Scoring-Accordion */
export function ScoringPromptAccordion({
                                         finalMap,
                                         items,
                                         onJumpToPage,
                                       }: {
  finalMap?: Record<string, any>;
  items: ScoringItem[];
  onJumpToPage?: (page: number) => void;
}) {
  const byPid = groupByPid(items || []);
  return (
      <>
        {Object.entries(byPid).map(([pid, list]) => {
          const fin = finalMap ? (finalMap as any)[`score_${pid}`] : undefined;
          return (
              <Accordion key={pid} defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography sx={{ flex: 1 }}>Scoring #{pid}</Typography>
                  {fin && (
                      <Chip
                          size="small"
                          label={`Final: ${fin.result ? "Ja" : "Nein"} (${(fin.confidence ?? 0).toFixed(2)})`}
                          color={fin.result ? "success" : "error"}
                          sx={{ ml: 1 }}
                      />
                  )}
                </AccordionSummary>
                <AccordionDetails>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Seite</TableCell>
                        <TableCell>Ergebnis</TableCell>
                        <TableCell>Begründung</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {list.map((r, i) => (
                          <TableRow
                              key={i}
                              hover
                              onClick={() => r.source?.page != null && onJumpToPage?.(r.source.page!)}
                              sx={{ cursor: r.source?.page != null ? "pointer" : "default" }}
                          >
                            <TableCell>{r.source?.page ?? "—"}</TableCell>
                            <TableCell>{r.result ? "Ja" : "Nein"}</TableCell>
                            <TableCell>{r.explanation ?? "—"}</TableCell>
                          </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
          );
        })}
      </>
  );
}

/** Decision-Accordion */
export function DecisionPromptAccordion({
                                          finalMap,
                                          items,
                                          onJumpToPage,
                                        }: {
  finalMap?: Record<string, any>;
  items: DecisionItem[];
  onJumpToPage?: (page: number) => void;
}) {
  const byPid = groupByPid(items || []);
  return (
      <>
        {Object.entries(byPid).map(([pid, list]) => {
          const fin = finalMap ? (finalMap as any)[`decision_${pid}`] : undefined;
          const header = list[0]?.prompt_text ?? `Prompt #${pid}`;
          return (
              <Accordion key={pid} defaultExpanded>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography sx={{ flex: 1 }}>
                    Decision #{pid}: <b>{header}</b>
                  </Typography>
                  {fin && (
                      <Chip
                          size="small"
                          label={`Final: ${fin.route} (${(fin.confidence ?? 0).toFixed(2)})`}
                          sx={{ ml: 1 }}
                      />
                  )}
                </AccordionSummary>
                <AccordionDetails>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Seite</TableCell>
                        <TableCell>Route/Answer</TableCell>
                        <TableCell>Explanation</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {list.map((r, i) => (
                          <TableRow
                              key={i}
                              hover
                              onClick={() => r.source?.page != null && onJumpToPage?.(r.source.page!)}
                              sx={{ cursor: r.source?.page != null ? "pointer" : "default" }}
                          >
                            <TableCell>{r.source?.page ?? "—"}</TableCell>
                            <TableCell>{r.route ?? (r.boolean == null ? "—" : r.boolean ? "YES" : "NO")}</TableCell>
                            <TableCell>
                              {typeof r.value === "object" && (r.value as any)?.explanation
                                  ? String((r.value as any).explanation)
                                  : "—"}
                            </TableCell>
                          </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>
          );
        })}
      </>
  );
}
