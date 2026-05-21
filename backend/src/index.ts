import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import mongoose from 'mongoose';
import voiceRouter from './routes/voice';
import ragRouter from './routes/rag';
import { errorHandler } from './middleware/errorHandler';
import logger from './utils/logger';

const app = express();
const PORT = process.env.PORT ?? 5000;
const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017/orvo-voice-ai';

app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/voice', voiceRouter);
app.use('/api/rag', ragRouter);
app.use(errorHandler);

async function bootstrap(): Promise<void> {
  await mongoose.connect(MONGO_URI);
  logger.info('MongoDB connected', { uri: MONGO_URI });
  app.listen(PORT, () => logger.info(`Backend running on port ${PORT}`));
}

bootstrap().catch((err) => {
  logger.error('Startup failed', { err });
  process.exit(1);
});
