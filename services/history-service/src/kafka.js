import { Kafka } from 'kafkajs';
import dotenv from 'dotenv';
import { markPending, insertResult } from './db.js';
import { broadcast } from './websocket.js';

dotenv.config({ path: process.env.CONFIG || undefined });

const broker = process.env.MESSAGE_BROKER_URL || 'localhost:9092';
const pdfBase = process.env.PDF_INGEST_URL || 'http://localhost:8081';

const kafka = new Kafka({ brokers: [broker] });
const consumer = kafka.consumer({ groupId: 'history-service' });

export async function startKafka() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'pdf-uploaded', fromBeginning: false });
  await consumer.subscribe({ topic: 'classification-result', fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      try {
        const data = JSON.parse(message.value.toString());
        console.log('kafka message received', topic, data.id);
        if (topic === 'pdf-uploaded') {
          const entry = {
            id: data.id,
            prompt: data.prompt,
            pdfUrl: `${pdfBase}/pdf/${data.id}`,
            timestamp: new Date().toISOString()
          };
          await markPending(entry);
          console.log('marked pending', entry.id);
          broadcast({ ...entry, status: 'running', result: null });
        } else if (topic === 'classification-result') {
          const entry = {
            id: data.id,
            prompt: data.prompt,
            result: { regress: data.regress, answer: data.answer },
            pdfUrl: `${pdfBase}/pdf/${data.id}`,
            timestamp: new Date().toISOString()
          };
          await insertResult(entry);
          console.log('stored result', entry.id, entry.result);
          broadcast({ ...entry, status: 'completed' });
        }
      } catch (e) {
        console.error('Kafka message error', e);
      }
    }
  });
  consumer.on('consumer.crash', async () => {
    console.error('Kafka consumer crashed, reconnecting...');
    setTimeout(startKafka, 5000);
  });
}
