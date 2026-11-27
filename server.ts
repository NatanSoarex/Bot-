import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  getBotSnapshot,
  requestPairingWithPhone,
  resetBotSession,
  restartBot,
  startBot,
  stopBot,
  switchToQrMode,
  updateBotConfig,
} from './src/bot.js';
import { parseClip } from './src/commands.js';
import {
  createAnimatedSticker,
  createStaticSticker,
  MAX_INPUT_BYTES,
  MAX_SECONDS,
  type FitMode,
  type StickerResult,
} from './src/convert.js';
import { ConversionError } from './src/ffmpeg.js';
import { downloadFromLink, findLink, LinkError, youtubeStart } from './src/link-download.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const app = express();

app.use('/api/bot', express.json());

app.get('/api/bot/status', (_req, res) => {
  res.json(getBotSnapshot());
});

app.post('/api/bot/start', async (_req, res) => {
  try {
    await startBot({ standalone: false });
    res.json(getBotSnapshot());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/bot/stop', async (_req, res) => {
  await stopBot();
  res.json(getBotSnapshot());
});

app.post('/api/bot/restart', async (_req, res) => {
  try {
    await restartBot();
    res.json(getBotSnapshot());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/bot/reset-session', async (_req, res) => {
  try {
    await resetBotSession();
    res.json(getBotSnapshot());
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/bot/pair', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { phone?: unknown };
    const phone = typeof body.phone === 'string' ? body.phone : '';
    const snapshot = await requestPairingWithPhone(phone);
    res.json(snapshot);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/bot/qr-mode', async (_req, res) => {
  try {
    const snapshot = await switchToQrMode();
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/bot/config', async (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const snapshot = await updateBotConfig({
      allowedNumbers: typeof body.allowedNumbers === 'string' ? body.allowedNumbers : undefined,
      pairingNumber: typeof body.pairingNumber === 'string' ? body.pairingNumber : undefined,
      stickerPackName: typeof body.stickerPackName === 'string' ? body.stickerPackName : undefined,
      stickerPublisher: typeof body.stickerPublisher === 'string' ? body.stickerPublisher : undefined,
      debug: typeof body.debug === 'boolean' ? body.debug : undefined,
    });
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function formatConvertResponse(result: StickerResult) {
  return {
    stickerBase64: result.sticker.toString('base64'),
    stickerBytes: result.sticker.length,
    audioBase64: result.audio ? result.audio.toString('base64') : undefined,
    audioBytes: result.audio?.length ?? 0,
    animated: result.animated,
    durationMs: result.durationMs,
    trimmed: result.trimmed,
    startSeconds: result.startSeconds,
    clipSeconds: result.clipSeconds,
    hasAudio: result.hasAudio,
    audioSilent: !!result.audioSilent,
    audioError: result.audioError?.message,
  };
}

app.post('/api/convert/link', express.json(), async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      url?: string;
      fit?: FitMode;
      withAudio?: boolean;
      clip?: string;
      packName?: string;
      publisher?: string;
    };
    const found = findLink(body.url ?? '');
    if (!found) {
      res.status(400).json({ error: 'Cole um link válido do TikTok, Instagram ou YouTube.' });
      return;
    }
    const parsedClip = body.clip?.trim() ? parseClip(`!som ${body.clip.trim()}`) : undefined;
    if (parsedClip && 'error' in parsedClip) {
      res.status(400).json({ error: parsedClip.error.replace(/\*/g, '') });
      return;
    }
    const linkStart = found.platform === 'youtube' ? youtubeStart(found.url) : undefined;
    const clip = parsedClip ?? (linkStart ? { start: linkStart } : undefined);
    const clipSeconds = Math.min(MAX_SECONDS, clip?.seconds ?? MAX_SECONDS);

    const video = await downloadFromLink(found, {
      maxBytes: MAX_INPUT_BYTES,
      clip: { start: clip?.start ?? 0, seconds: clipSeconds },
    });
    const startOffset = video.startApplied ? (clip?.start ?? 0) : 0;
    const snap = getBotSnapshot();
    const result = await createAnimatedSticker(video.buffer, {
      fit: body.fit === 'inteiro' ? 'inteiro' : 'cortar',
      withAudio: body.withAudio !== false,
      startSeconds: (clip?.start ?? 0) - startOffset,
      maxSeconds: clipSeconds,
      meta: {
        packName: body.packName ?? snap.config.stickerPackName,
        publisher: body.publisher ?? snap.config.stickerPublisher,
      },
    });
    res.json(formatConvertResponse(result));
  } catch (error) {
    const msg = error instanceof LinkError || error instanceof ConversionError
      ? error.message
      : 'Não foi possível converter esse link.';
    res.status(400).json({ error: msg });
  }
});

app.post(
  '/api/convert/file',
  express.raw({ type: '*/*', limit: '17mb' }),
  async (req, res) => {
    try {
      const input = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!input.length) {
        res.status(400).json({ error: 'Envie um arquivo de vídeo, GIF ou imagem.' });
        return;
      }
      if (input.length > MAX_INPUT_BYTES) {
        res.status(400).json({ error: 'O arquivo passa de 16 MB.' });
        return;
      }
      const fit: FitMode = req.query.fit === 'inteiro' ? 'inteiro' : 'cortar';
      const withAudio = req.query.withAudio !== 'false';
      const mime = typeof req.query.mime === 'string' ? req.query.mime : String(req.headers['content-type'] ?? '');
      const isImage = req.query.kind === 'image' || mime.startsWith('image/');
      const isGif = mime === 'image/gif';
      const clipText = typeof req.query.clip === 'string' ? req.query.clip.trim() : '';
      const parsedClip = clipText ? parseClip(`!som ${clipText}`) : undefined;
      if (parsedClip && 'error' in parsedClip) {
        res.status(400).json({ error: parsedClip.error.replace(/\*/g, '') });
        return;
      }

      const snap = getBotSnapshot();
      const meta = {
        packName: typeof req.query.packName === 'string' ? req.query.packName : snap.config.stickerPackName,
        publisher: typeof req.query.publisher === 'string' ? req.query.publisher : snap.config.stickerPublisher,
      };

      if (isImage && !isGif) {
        const result = await createStaticSticker(input, fit, meta);
        res.json(formatConvertResponse(result));
        return;
      }

      const result = await createAnimatedSticker(input, {
        fit,
        withAudio,
        startSeconds: parsedClip?.start,
        maxSeconds: parsedClip?.seconds,
        meta,
      });
      res.json(formatConvertResponse(result));
    } catch (error) {
      const msg = error instanceof ConversionError
        ? error.message
        : 'Não foi possível converter esse arquivo.';
      res.status(400).json({ error: msg });
    }
  },
);

app.post('/api/convert/sample', express.json(), async (req, res) => {
  try {
    const body = (req.body ?? {}) as { fit?: FitMode; withAudio?: boolean; clip?: string };
    const samplePath = path.join(__dirname, 'docs', 'exemplo-lhama.mp4');
    const input = await readFile(samplePath);
    const parsedClip = body.clip?.trim() ? parseClip(`!som ${body.clip.trim()}`) : undefined;
    if (parsedClip && 'error' in parsedClip) {
      res.status(400).json({ error: parsedClip.error.replace(/\*/g, '') });
      return;
    }
    const snap = getBotSnapshot();
    const result = await createAnimatedSticker(input, {
      fit: body.fit === 'inteiro' ? 'inteiro' : 'cortar',
      withAudio: body.withAudio !== false,
      startSeconds: parsedClip?.start,
      maxSeconds: parsedClip?.seconds,
      meta: {
        packName: snap.config.stickerPackName,
        publisher: snap.config.stickerPublisher,
      },
    });
    res.json(formatConvertResponse(result));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode
    ?? 500;
  const type = (err as { type?: string })?.type;
  if (status === 413 || type === 'entity.too.large') {
    res.status(413).json({ error: 'O arquivo passa de 16 MB. Corte o vídeo ou escolha um menor.' });
    return;
  }
  const message = err instanceof Error ? err.message : 'Erro interno no servidor.';
  res.status(status).json({ error: message });
});

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`Bot-fig rodando em http://${HOST}:${PORT}`);
  });

  // Inicia o bot do WhatsApp em segundo plano sem bloquear o servidor HTTP
  startBot({ standalone: false }).catch(error => {
    console.error('Erro ao iniciar o bot:', error);
  });
}

main().catch(error => {
  console.error('Falha ao iniciar o servidor:', error);
  process.exit(1);
});
