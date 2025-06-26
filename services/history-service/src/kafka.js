import { Kafka } from 'kafkajs';
import dotenv from 'dotenv';
import { insert } from './db.js';
import { broadcast } from './websocket.js';

dotenv.config({ path: process.env.CONFIG || undefined });

const broker = process.env.MESSAGE_BROKER_URL || 'localhost:9092';
const pdfBase = process.env.PDF_INGEST_URL || 'http://localhost:8081';

const kafka = new Kafka({ brokers: [broker] });
const consumer = kafka.consumer({ groupId: 'history-service' });

export async function startKafka() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'classification-result', fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const data = JSON.parse(message.value.toString());
        const entry = {
          id: data.id,
          prompt: data.prompt,
          result: { regress: data.regress, answer: data.answer },
          pdfUrl: `${pdfBase}/pdf/${data.id}`,
          timestamp: new Date().toISOString()
        };
        await insert(entry);
        broadcast(entry);
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
