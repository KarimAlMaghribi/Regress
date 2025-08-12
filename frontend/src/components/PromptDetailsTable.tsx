import React from 'react';
import { Table, TableHead, TableRow, TableCell, TableBody } from '@mui/material';
import { TextPosition } from '../types/pipeline';

interface Props {
  data: any[];
  onSelect?: (source: TextPosition) => void;
}

export default function PromptDetailsTable({ data, onSelect }: Props) {
  return (
    <Table size="small" sx={{ '& td, & th': { fontSize: '0.8rem' } }}>
      <TableHead>
        <TableRow>
          <TableCell>ID</TableCell>
          <TableCell>Prompt</TableCell>
          <TableCell>Quote</TableCell>
          <TableCell>Score/Bool</TableCell>
          <TableCell>Route</TableCell>
          <TableCell>Source</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {data.map((p, i) => {
          const promptId = p.promptId ?? p.prompt_id ?? i;
          const promptText = p.promptText ?? p.prompt_text;
          const handleClick = () => {
            if (onSelect && p.source) onSelect(p.source as TextPosition);
          };
          return (
            <TableRow
              key={promptId}
              hover={!!onSelect}
              onClick={handleClick}
              sx={{ cursor: onSelect && p.source ? 'pointer' : 'default' }}
            >
              <TableCell>{promptId}</TableCell>
              <TableCell title={promptText ?? ''}>{promptText ? `${promptText.slice(0, 40)}…` : '—'}</TableCell>
              <TableCell>{p.source?.quote ?? '—'}</TableCell>
              <TableCell>{(p as any).score ?? String((p as any).boolean ?? (p as any).result ?? '')}</TableCell>
              <TableCell>{p.route ?? 'Root'}</TableCell>
              <TableCell>
                {p.source ? `p${p.source.page} [${p.source.bbox.join(',')}]` : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
