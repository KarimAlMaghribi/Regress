import { PipelineStep } from '../../hooks/usePipelineStore';
import { usePipelineStore } from '../../hooks/usePipelineStore';

/** edits the targets-map */
export default function StepBranchPanel({ step }: { step: PipelineStep }) {
  const { updateStep, steps: allSteps } = usePipelineStore();

  const setTarget = (key: string, value: string) => {
    updateStep(step.id, {
      targets: { ...(step.targets || {}), [key]: value },
    }).catch(() => {});
  };

  return (
    <div className="branch-panel">
      <table>
        <thead><tr><th>Route</th><th>Next Step</th></tr></thead>
        <tbody>
          {Object.entries(step.targets || {}).map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>
                <select value={v}
                        onChange={e => setTarget(k, e.target.value)}>
                  {allSteps.map(s => <option key={s.id} value={s.id}>{s.id}</option>)}
                </select>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <input placeholder="new key" onKeyDown={e => {
                if (e.key === 'Enter') {
                  setTarget(e.currentTarget.value, '');
                  e.currentTarget.value = '';
                }
              }} />
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
