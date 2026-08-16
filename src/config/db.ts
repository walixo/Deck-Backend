import mongoose from 'mongoose';
import { env } from './env';

export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    // eslint-disable-next-line no-console
    console.log('[db] connected');
  });

  mongoose.connection.on('error', (error) => {
    // eslint-disable-next-line no-console
    console.error('[db] connection error:', error.message);
  });

  await mongoose.connect(env.mongoUri);
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
