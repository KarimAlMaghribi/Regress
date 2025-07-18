import React from 'react';
import { motion } from 'framer-motion';

interface Props {
  data: any;
  onRepeat?: () => void;
}

export default function PromptNode({ data, onRepeat }: Props) {
  return (
    <motion.div
      className={`node ${data.type}`}
      initial={{ scale: 0.8, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 260, damping: 20 }}
    >
      <strong>{data.label}</strong>
      {data.score !== undefined && (
        <span className="badge">{data.score.toFixed(2)}</span>
      )}
      {data.answer && (
        <details>
          <summary>📝 Answer</summary>
          <pre>{data.answer}</pre>
          {data.source && <em>📄 {data.source}</em>}
        </details>
      )}
      {data.confidence !== undefined &&
        data.confidenceThreshold !== undefined &&
        data.confidence < data.confidenceThreshold && (
          <motion.button
            whileTap={{ scale: 0.9 }}
            onClick={onRepeat}
            style={{ marginTop: 4 }}
          >
            🔁 Repeat
          </motion.button>
        )}
    </motion.div>
  );
}
