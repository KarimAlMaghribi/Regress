import React, { useState } from 'react';
import { usePipelineStore, PipelineStep } from '../../hooks/usePipelineStore';
import { Box, TextField, Button } from '@mui/material';

export default function StepBranchPanel({ step }: { step: PipelineStep }) {
  const { updateStep, steps: allSteps } = usePipelineStore();
  const [keyInputs, setKeyInputs] = useState<{yes?:string,no?:string,merge?:string}>({});

  const writeKeys = () => {
    updateStep(step.id, {
      yesKey: keyInputs.yes,
      noKey:  keyInputs.no,
      mergeKey: keyInputs.merge,
      targets: { [keyInputs.yes!]: '', [keyInputs.no!]: '' },
      mergeTo: ''
    }).catch(()=>{});
  };

  // Wizard: require yes/no/merge
  if (step.type === 'DecisionPrompt' && (!step.yesKey || !step.noKey || !step.mergeKey)) {
    return (
      <Box sx={{ p:2 }}>
        <TextField label="Yes-Key" fullWidth
          value={keyInputs.yes||''}
          onChange={e=>setKeyInputs(k=>({ ...k, yes:e.target.value }))} />
        <TextField label="No-Key" fullWidth sx={{ mt:2 }}
          value={keyInputs.no||''}
          onChange={e=>setKeyInputs(k=>({ ...k, no:e.target.value }))} />
        <TextField label="Merge-Key" fullWidth sx={{ mt:2 }}
          value={keyInputs.merge||''}
          onChange={e=>setKeyInputs(k=>({ ...k, merge:e.target.value }))} />
        <Button variant="contained" fullWidth sx={{ mt:2 }}
          disabled={!(keyInputs.yes && keyInputs.no && keyInputs.merge)}
          onClick={writeKeys}>
          Save Routes
        </Button>
      </Box>
    );
  }

  // Fixed 3-row branch panel
  return (
    <table>
      <thead><tr><th>Route</th><th>Next Step</th></tr></thead>
      <tbody>
        {[[step.yesKey,''],[step.noKey,'']].map(([k])=> (
          <tr key={k as string}>
            <td>{k}</td>
            <td>
              <select value={step.targets?.[k as string]||''}
                      onChange={e=>updateStep(step.id,{ targets:{ ...step.targets, [k as string]:e.target.value } }).catch(()=>{})}>
                <option value="">(none)</option>
                {allSteps.map(s=><option key={s.id} value={s.id}>{s.id}</option>)}
              </select>
            </td>
          </tr>
        ))}
        <tr key="merge">
          <td>{step.mergeKey}</td>
          <td>
            <select value={step.mergeTo||''}
                    onChange={e=>updateStep(step.id,{ mergeTo:e.target.value }).catch(()=>{})}>
              <option value="">(none)</option>
              {allSteps.map(s=><option key={s.id} value={s.id}>{s.id}</option>)}
            </select>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
