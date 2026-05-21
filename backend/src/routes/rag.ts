import { Router } from 'express';
import multer from 'multer';
import { uploadDocument, listDocuments, removeDocument } from '../controllers/ragController';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF, Word (.docx), and plain text files are allowed'));
  },
});

router.post('/upload', upload.single('file'), uploadDocument);
router.get('/documents', listDocuments);
router.delete('/documents/:documentId', removeDocument);

export default router;
