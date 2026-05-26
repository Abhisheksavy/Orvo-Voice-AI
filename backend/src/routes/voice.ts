import { Router } from 'express';
import multer from 'multer';
import { createSession, voiceChat, voiceChatStream, textChat, getHistory, clearHistory } from '../controllers/voiceController';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_AUDIO_SIZE_MB) || 10) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/webm', 'audio/wav', 'audio/mp3', 'audio/mpeg', 'audio/ogg', 'audio/mp4'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  },
});

router.post('/session', createSession);
router.post('/chat', upload.single('audio'), voiceChat);
router.post('/chat-stream', upload.single('audio'), voiceChatStream);
router.post('/chat-text', textChat);
router.get('/history/:sessionId', getHistory);
router.delete('/history/:sessionId', clearHistory);

export default router;
