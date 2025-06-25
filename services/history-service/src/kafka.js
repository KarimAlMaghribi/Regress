import { Kafka } from 'kafkajs';
import dotenv from 'dotenv';
import { insert } from './db.js';
import { broadcast } from './websocket.js';

dotenv.config({ path: process.env.CONFIG || undefined });

const broker = process.env.MESSAGE_BROKER_URL || 'localhost:9092';

const kafka = new Kafka({ brokers: [broker] });
const consumer = kafka.consumer({ groupId: 'history-service' });

export async function startKafka() {
  await consumer.connect();
  await consumer.subscribe({ topic: 'classification-result', fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const payload = JSON.parse(message.value.toString());
        // expecting { id, prompt, result, pdfUrl, timestamp }
        await insert(payload);
        broadcast(payload);
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
