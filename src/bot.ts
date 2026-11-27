import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import makeWASocket, {
  DisconnectReason, downloadMediaMessage, jidDecode, normalizeMessageContent, useMultiFileAuthState,
  type WAMessage, type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { assumedBrazilian, findMedia, findMessageLink, formatTime, HELP_TEXT, messageText, parseClip, parseCommand, parseFit, allowedNumberWarnings, phoneVariants, type Command } from './commands.js';
import { createAnimatedSticker, createStaticSticker, MAX_INPUT_BYTES, MAX_SECONDS, type StickerResult } from './convert.js';
import { checkTools, ConversionError, ToolError } from './ffmpeg.js';
import { downloadFromLink, LinkError, PLATFORM_NAME, youtubeStart, type FoundLink, type LinkClip } from './link-download.js';
import { JobQueue, TimeoutError } from './queue.js';
import { markConnected, setQr, startQrPage } from './qr-page.js';
import { sendSoundSticker } from './sound-sticker.js';

export type BotConnectionStatus =
  | 'idle'
  | 'starting'
  | 'qr'
  | 'pairing_code'
  | 'connected'
  | 'reconnecting'
  | 'logged_out'
  | 'error'
  | 'stopped';

export type BotLogEntry = {
  id: number;
  time: string;
  level: 'info' | 'error';
  message: string;
};

export type BotRuntimeConfig = {
  allowedNumbers: string;
  pairingNumber: string;
  stickerPackName: string;
  stickerPublisher: string;
  debug: boolean;
  maxPending: number;
  authDir: string;
};

export type BotSnapshot = {
  status: BotConnectionStatus;
  qr?: string;
  qrSvg?: string;
  pairingCode?: string;
  user?: { id: string; name?: string };
  errorMessage?: string;
  toolProblems: string[];
  warnings: string[];
  queueSize: number;
  stats: {
    soundStickersSent: number;
    plainStickersSent: number;
    errors: number;
  };
  config: BotRuntimeConfig;
  logs: BotLogEntry[];
};

const MAX_AGE_SECONDS = 5 * 60;
const MAX_LOGS = 120;
const QR_PORT = Number(process.env.QR_PORT || 3999);
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

const config: BotRuntimeConfig = {
  allowedNumbers: process.env.ALLOWED_NUMBERS ?? '',
  pairingNumber: (process.env.NUMERO_CONEXAO ?? '').replace(/\D/g, ''),
  stickerPackName: process.env.STICKER_PACK_NAME ?? 'Criada por Dexter',
  stickerPublisher: process.env.STICKER_PUBLISHER ?? '',
  debug: process.env.DEBUG === 'true',
  maxPending: Number(process.env.MAX_PENDING || 5),
  authDir: process.env.AUTH_DIR || './sessao',
};

let allowedList: string[] = [];
let allowedSet = new Set<string>();
function refreshAllowed(): void {
  allowedList = config.allowedNumbers.split(/[,;\s]+/).filter(n => /\d/.test(n));
  allowedSet = new Set(allowedList.flatMap(phoneVariants));
}
refreshAllowed();

let socket: WASocket | undefined;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
let stopping = false;
let standaloneMode = false;
let logSeq = 0;

let status: BotConnectionStatus = 'idle';
let currentQr: string | undefined;
let currentQrSvg: string | undefined;
let currentPairingCode: string | undefined;
let connectedUser: { id: string; name?: string } | undefined;
let errorMessage: string | undefined;
let toolProblems: string[] = [];
const stats = { soundStickersSent: 0, plainStickersSent: 0, errors: 0 };
const logs: BotLogEntry[] = [];

function pushLog(level: 'info' | 'error', ...parts: unknown[]): void {
  const time = new Date().toLocaleTimeString('pt-BR');
  const message = parts.map(p => (p instanceof Error ? p.message : typeof p === 'string' ? p : String(p))).join(' ');
  logs.push({ id: ++logSeq, time, level, message });
  if (logs.length > MAX_LOGS) logs.shift();
  if (level === 'error') console.error(`[${time}]`, ...parts);
  else console.log(`[${time}]`, ...parts);
}

const log = (...parts: unknown[]) => pushLog('info', ...parts);
const logError = (...parts: unknown[]) => pushLog('error', ...parts);

const queue = new JobQueue(config.maxPending, 3 * 60_000, error => {
  stats.errors++;
  logError('Pedido interrompido:', error);
});

// ---------------------------------------------------------------- utilidades

const handled = new Set<string>();
function firstTime(message: WAMessage): boolean {
  const id = `${message.key.remoteJid}|${message.key.id}`;
  if (handled.has(id)) return false;
  handled.add(id);
  if (handled.size > 2000) handled.delete(handled.values().next().value!);
  return true;
}

/** Telefone de quem mandou a mensagem, resolvendo o formato @lid quando preciso. */
async function senderPhone(message: WAMessage): Promise<string | undefined> {
  if (!socket) return undefined;
  const key = message.key;
  const group = key.remoteJid?.endsWith('@g.us');
  const candidates = group ? [key.participantAlt, key.participant] : [key.remoteJidAlt, key.remoteJid];
  for (const jid of candidates) if (jid?.endsWith('@s.whatsapp.net')) return jidDecode(jid)?.user;
  const lid = candidates.find(jid => jid?.endsWith('@lid'));
  if (lid) {
    const pn = await socket.signalRepository.lidMapping.getPNForLID(lid).catch(() => null);
    if (pn) return jidDecode(pn)?.user;
  }
  return undefined;
}

async function allowed(message: WAMessage): Promise<boolean> {
  if (message.key.fromMe || !allowedSet.size) return true;
  const phone = await senderPhone(message);
  const ok = !!phone && allowedSet.has(phone);
  if (!ok && config.debug) {
    log(`[recusado] remetente ${phone ? `…${phone.slice(-4)} (${phone.length} dígitos) não está em ALLOWED_NUMBERS` : 'sem número conhecido (só @lid, sem mapa para telefone)'}`);
  }
  return ok;
}

async function reply(message: WAMessage, text: string): Promise<void> {
  if (!socket) return;
  await socket.sendMessage(message.key.remoteJid!, { text }, { quoted: message }).catch(error => logError('Não consegui responder:', error));
}

async function react(message: WAMessage, emoji: string): Promise<void> {
  if (!socket) return;
  await socket.sendMessage(message.key.remoteJid!, { react: { text: emoji, key: message.key } }).catch(() => {});
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Tenta de novo uma vez (rede instável, upload que caiu). Erros de conversão não são repetidos. */
async function retryOnce<T>(work: () => Promise<T>, label: string): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof ConversionError) throw error;
    logError(`${label} falhou, tentando de novo:`, error instanceof Error ? error.message : error);
    await wait(1500);
    return work();
  }
}

class DownloadError extends Error {}

async function download(source: WAMessage): Promise<Buffer> {
  if (!socket) throw new DownloadError('Bot desconectado.');
  const activeSocket = socket;
  try {
    const buffer = await retryOnce(() => downloadMediaMessage(source, 'buffer',
      { options: { signal: AbortSignal.timeout(60_000) } }, { logger, reuploadRequest: activeSocket.updateMediaMessage }), 'Download');
    if (buffer.length > MAX_INPUT_BYTES) throw new ConversionError('O arquivo passa de 16 MB.');
    return buffer;
  } catch (error) {
    if (error instanceof ConversionError) throw error;
    throw new DownloadError(error instanceof Error ? error.message : String(error));
  }
}

/** Texto amigável para cada tipo de falha. */
function friendlyError(error: unknown): string {
  if (error instanceof ConversionError) return `Não consegui criar a figurinha: ${error.message}`;
  if (error instanceof LinkError) return error.message;
  if (error instanceof DownloadError) return 'Não consegui baixar o arquivo do WhatsApp (ele pode ter expirado). Reenvie o vídeo e tente de novo.';
  if (error instanceof TimeoutError) return 'Demorou demais para processar. Tente um vídeo mais curto ou mais leve.';
  if (error instanceof ToolError && /não foi encontrado/.test(error.message)) return 'O bot está sem o FFmpeg instalado. Avise quem cuida dele.';
  return 'Algo deu errado ao criar a figurinha. Tente de novo ou com outro arquivo.';
}

// ---------------------------------------------------------------- pedidos

async function sendPlainSticker(message: WAMessage, result: StickerResult): Promise<void> {
  if (!socket) throw new Error('Bot desconectado.');
  const activeSocket = socket;
  await retryOnce(() => activeSocket.sendMessage(message.key.remoteJid!,
    { sticker: result.sticker, isAnimated: result.animated, width: 512, height: 512 }, { quoted: message }), 'Envio da figurinha');
}

/** Tenta a figurinha com som; devolve um aviso se precisou cair para a versão sem som. */
async function trySoundSticker(message: WAMessage, media: { gif: boolean }, result: StickerResult): Promise<{ sent: boolean; notice?: string }> {
  if (!socket) return { sent: false, notice: 'Bot desconectado.' };
  const activeSocket = socket;
  if (!result.hasAudio) return { sent: false, notice: media.gif ? 'GIF não tem som, então mandei sem som.' : 'Esse vídeo não tem áudio, então mandei sem som.' };
  if (result.audioSilent) return { sent: false, notice: 'O áudio desse vídeo está mudo, então mandei sem som.' };
  if (!result.audio) {
    logError('Falha ao extrair o áudio:', result.audioError);
    return { sent: false, notice: 'Não consegui extrair o áudio desse vídeo, então mandei sem som.' };
  }
  try {
    await retryOnce(() => sendSoundSticker(activeSocket, message.key.remoteJid!,
      { sticker: result.sticker, audio: result.audio!, durationMs: result.durationMs, quoted: message }), 'Envio com som');
    return { sent: true };
  } catch (error) {
    logError('Falha no envio com som:', error);
    return { sent: false, notice: 'O WhatsApp recusou a versão com som, então mandei sem som.' };
  }
}

async function linkDownload(link: FoundLink, maxBytes: number, clip: LinkClip) {
  return downloadFromLink(link, { maxBytes, clip, log: config.debug ? m => log(`[link] ${m}`) : undefined });
}

/** Aviso sobre o trecho usado ("Usei de 0:42 a 0:52."), quando não foi o vídeo inteiro desde o começo. */
function clipNotice(result: StickerResult, startOffset: number, explicit: boolean): string | undefined {
  const start = startOffset + (result.startSeconds ?? 0);
  const end = start + (result.clipSeconds ?? result.durationMs / 1000);
  if (explicit || start > 0) return `Usei o trecho de ${formatTime(start)} a ${formatTime(end)}.`;
  if (result.trimmed) return 'Usei só os primeiros 10 segundos. Para outro trecho, mande por exemplo *!som 0:42*.';
  return undefined;
}

async function handle(command: Command, text: string, message: WAMessage): Promise<void> {
  if (command === 'ajuda') { await reply(message, HELP_TEXT); return; }
  const media = findMedia(message);
  const link = media ? undefined : findMessageLink(message);
  if (!media && !link) {
    await reply(message, command === 'som'
      ? 'Mande um vídeo com a legenda *!som*, responda a um vídeo com *!som*, ou mande *!som <link>* do TikTok, Instagram ou YouTube.'
      : 'Mande uma foto, vídeo ou GIF com a legenda *!fig*, responda a um deles com *!fig*, ou mande *!fig <link>*.');
    return;
  }
  if (media && media.fileLength > MAX_INPUT_BYTES) { await reply(message, 'Esse arquivo passa de 16 MB. Corte o vídeo ou mande um menor.'); return; }

  // Trecho: "!som 0:42" / "!som 0:42-0:47"; sem isso, o tempo do link do YouTube (?t=42), se houver.
  const parsedClip = parseClip(text);
  if (parsedClip && 'error' in parsedClip) { await reply(message, parsedClip.error); return; }
  const linkStart = link?.platform === 'youtube' ? youtubeStart(link.url) : undefined;
  const clip = parsedClip ?? (linkStart ? { start: linkStart } : undefined);
  const clipSeconds = Math.min(MAX_SECONDS, clip?.seconds ?? MAX_SECONDS);

  const started = performance.now();
  const steps: string[] = [];
  const meta = { packName: config.stickerPackName, publisher: config.stickerPublisher };
  await react(message, '⏳');
  try {
    const fit = parseFit(text);
    let input: Buffer;
    // Quanto do início já foi pulado na origem (o link baixou só o trecho).
    let startOffset = 0;
    if (media) input = await download(media.message);
    else {
      const t0 = performance.now();
      const video = await linkDownload(link!, MAX_INPUT_BYTES, { start: clip?.start ?? 0, seconds: clipSeconds });
      input = video.buffer;
      if (video.startApplied) startOffset = clip?.start ?? 0;
      steps.push(`link ${PLATFORM_NAME[link!.platform]} ${Math.round(performance.now() - t0)}ms`);
    }
    if (media?.kind === 'image') {
      const result = await createStaticSticker(input, fit, meta);
      await sendPlainSticker(message, result);
      stats.plainStickersSent++;
      if (command === 'som') await reply(message, 'Foto não tem som 🙂 Mandei uma figurinha comum.');
      await react(message, '✅');
      log(`!${command} foto ok em ${((performance.now() - started) / 1000).toFixed(1)} s`);
      return;
    }

    const result = await createAnimatedSticker(input, {
      fit, meta, withAudio: command === 'som',
      startSeconds: (clip?.start ?? 0) - startOffset, maxSeconds: clipSeconds,
      onStep: config.debug ? (step, ms) => steps.push(`${step} ${Math.round(ms)}ms`) : undefined,
    });
    const notices: string[] = [];
    const clipText = clipNotice(result, startOffset, !!parsedClip);
    if (clipText) notices.push(clipText);

    let withSound = false;
    if (command === 'som') {
      const sound = await trySoundSticker(message, { gif: media?.gif ?? false }, result);
      withSound = sound.sent;
      if (sound.notice) notices.push(sound.notice);
    }
    if (!withSound) {
      await sendPlainSticker(message, result);
      stats.plainStickersSent++;
    } else {
      stats.soundStickersSent++;
    }
    await react(message, withSound ? '🔊' : '✅');
    if (notices.length) await reply(message, notices.join('\n'));
    log(`!${command}${link ? ` (link ${PLATFORM_NAME[link.platform]})` : ''} ${withSound ? 'com som' : 'sem som'} ok em ${((performance.now() - started) / 1000).toFixed(1)} s` +
      ` (${Math.round(result.sticker.length / 1024)} KB)${steps.length ? ` — ${steps.join(', ')}` : ''}`);
  } catch (error) {
    stats.errors++;
    logError(`!${command} falhou em ${((performance.now() - started) / 1000).toFixed(1)} s:`, error);
    await react(message, '❌');
    await reply(message, friendlyError(error));
  }
}

function logArrival(type: string, message: WAMessage): void {
  const chat = message.key.remoteJid?.split('@')[1] ?? '?';
  const content = normalizeMessageContent(message.message);
  const kinds = content ? Object.keys(content).filter(k => k !== 'messageContextInfo').join(',') : '(sem conteúdo)';
  const age = message.messageTimestamp ? Math.round(Date.now() / 1000 - Number(message.messageTimestamp)) : '?';
  log(`[chegou] upsert=${type} chat=@${chat} deMim=${!!message.key.fromMe} tipo=${kinds}` +
    `${message.messageStubType ? ` stub=${message.messageStubType}` : ''} idade=${age}s comando=${parseCommand(messageText(content)) ?? '-'}`);
}

async function onMessage(message: WAMessage): Promise<void> {
  if (!message.message || message.key.remoteJid === 'status@broadcast') return;
  const sentAt = Number(message.messageTimestamp ?? 0);
  if (sentAt && Date.now() / 1000 - sentAt > MAX_AGE_SECONDS) return; // não processa mensagens antigas ao reconectar
  const text = messageText(normalizeMessageContent(message.message));
  const command = parseCommand(text);
  if (!command || !firstTime(message)) return;
  if (!(await allowed(message))) return;

  const owner = `${message.key.remoteJid}|${message.key.participant ?? ''}|${message.key.fromMe ? 'eu' : ''}`;
  const result = queue.add(owner, () => handle(command, text, message));
  if (result.status === 'full') await reply(message, 'Estou com muitos pedidos agora. Tente de novo em um minuto.');
  else if (result.status === 'duplicate') await reply(message, 'Ainda estou fazendo seu pedido anterior. Espere ele chegar e mande de novo.');
  else if (result.position > 1) await reply(message, `Na fila: você é o ${result.position}º. Já já sai!`);
}

// ---------------------------------------------------------------- conexão

async function connect(): Promise<void> {
  if (stopping) return;
  status = 'starting';
  errorMessage = undefined;
  await mkdir(config.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const current = makeWASocket({ auth: state, logger, markOnlineOnConnect: false, syncFullHistory: false });
  socket = current;
  current.ev.on('creds.update', () => { saveCreds().catch(error => logError('Não consegui salvar a sessão:', error)); });
  let codeRequested = false;
  current.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (socket !== current) return;
    if (qr && config.pairingNumber) {
      if (!codeRequested) {
        codeRequested = true;
        current.requestPairingCode(config.pairingNumber)
          .then(code => {
            currentPairingCode = `${code.slice(0, 4)}-${code.slice(4)}`;
            currentQr = undefined;
            currentQrSvg = undefined;
            status = 'pairing_code';
            log(`Código de conexão: ${currentPairingCode}`);
            if (standaloneMode) {
              console.log(`\nCódigo de conexão: ${currentPairingCode}\nNo celular: WhatsApp > Aparelhos conectados > Conectar um aparelho > Conectar com número de telefone.\n`);
            }
          })
          .catch(error => {
            errorMessage = 'Não consegui gerar o código de conexão. Confira o número informado (ex.: 5511999998888).';
            logError('Não consegui gerar o código. Confira NUMERO_CONEXAO:', error);
          });
      }
    } else if (qr) {
      currentQr = qr;
      currentPairingCode = undefined;
      status = 'qr';
      try {
        currentQrSvg = await QRCode.toString(qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' });
      } catch {
        currentQrSvg = undefined;
      }
      if (standaloneMode) {
        setQr(qr);
        startQrPage(QR_PORT, { open: process.env.ABRIR_QR === 'true' });
        console.log('\nEscaneie o QR no WhatsApp: Configurações › Aparelhos conectados › Conectar um aparelho');
        console.log(`(ou abra http://localhost:${QR_PORT} para ver o QR como imagem)\n`);
        qrcodeTerminal.generate(qr, { small: true });
      } else {
        log('Novo QR code gerado. Escaneie no painel web para conectar o WhatsApp.');
      }
    }
    if (connection === 'open') {
      reconnectAttempt = 0;
      currentQr = undefined;
      currentQrSvg = undefined;
      currentPairingCode = undefined;
      errorMessage = undefined;
      status = 'connected';
      connectedUser = current.user ? { id: current.user.id, name: current.user.name } : undefined;
      if (standaloneMode) markConnected();
      log(`Bot conectado. Comandos: !som, !fig, !ajuda. ${allowedSet.size ? `Liberado para ${allowedList.length} número(s).` : 'Liberado para todos.'}`);
    }
    if (connection === 'close' && !stopping && socket === current) {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        const msg = `O celular desconectou o bot. Apague a sessão ("${config.authDir}") e conecte novamente.`;
        logError(msg);
        status = 'logged_out';
        errorMessage = msg;
        connectedUser = undefined;
        currentQr = undefined;
        currentQrSvg = undefined;
        if (standaloneMode) process.exit(1);
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        const msg = 'Outra cópia do bot abriu esta mesma sessão. Feche a outra antes de rodar esta.';
        logError(msg);
        status = 'error';
        errorMessage = msg;
        connectedUser = undefined;
        if (standaloneMode) process.exit(1);
        return;
      }
      if (code === DisconnectReason.forbidden) {
        const msg = 'O WhatsApp recusou a conexão (403). O número pode ter sido bloqueado.';
        logError(msg);
        status = 'error';
        errorMessage = msg;
        connectedUser = undefined;
        if (standaloneMode) process.exit(1);
        return;
      }
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60_000, 1000 * 2 ** Math.min(reconnectAttempt++, 6));
      status = 'reconnecting';
      log(`Conexão caiu (código ${code ?? '?'}). Tentando de novo em ${(delay / 1000).toFixed(1)} s.`);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { connect().catch(error => logError('Falha ao reconectar:', error)); }, delay);
    }
  });
  current.ev.on('messages.upsert', ({ messages, type }) => {
    for (const message of messages) {
      if (config.debug) logArrival(type, message);
      if (type !== 'notify' && type !== 'append') continue;
      onMessage(message).catch(error => logError('Erro ao ler mensagem:', error));
    }
  });
}

// ---------------------------------------------------------------- API pública de controle

export async function startBot(options: { standalone?: boolean } = {}): Promise<void> {
  standaloneMode = !!options.standalone;
  stopping = false;
  clearTimeout(reconnectTimer);
  toolProblems = await checkTools();
  for (const warning of allowedNumberWarnings(allowedList)) {
    log(`⚠️ ALLOWED_NUMBERS: ${warning}`);
  }
  if (toolProblems.length) {
    status = 'error';
    errorMessage = 'O bot não pode começar:\n- ' + toolProblems.join('\n- ');
    logError(errorMessage);
    if (standaloneMode) {
      console.error(errorMessage);
      console.error('Instale um FFmpeg completo (ex.: https://www.gyan.dev/ffmpeg/builds/ no Windows, "apt install ffmpeg" no Linux, "brew install ffmpeg" no macOS).');
      process.exit(1);
    }
    return;
  }
  await connect();
}

export async function stopBot(): Promise<void> {
  stopping = true;
  clearTimeout(reconnectTimer);
  const current = socket;
  socket = undefined;
  current?.end(undefined);
  currentQr = undefined;
  currentQrSvg = undefined;
  currentPairingCode = undefined;
  connectedUser = undefined;
  status = 'stopped';
  log('Bot parado.');
}

export async function restartBot(): Promise<void> {
  await stopBot();
  reconnectAttempt = 0;
  await startBot({ standalone: standaloneMode });
}

export async function resetBotSession(): Promise<void> {
  await stopBot();
  await rm(config.authDir, { recursive: true, force: true });
  reconnectAttempt = 0;
  log(`Sessão apagada em "${config.authDir}". Gerando nova conexão...`);
  await startBot({ standalone: standaloneMode });
}

function normalizePairingPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  return assumedBrazilian(digits) ? `55${digits}` : digits;
}

export async function requestPairingWithPhone(rawPhone: string): Promise<BotSnapshot> {
  if (status === 'connected') {
    throw new Error('O bot já está conectado. Clique em "Nova sessão" se quiser vincular outro número.');
  }
  const normalized = normalizePairingPhone(rawPhone);
  if (normalized.length < 10) {
    throw new Error('Número inválido. Informe DDI + DDD + número (ex.: 5511999998888).');
  }
  config.pairingNumber = normalized;
  errorMessage = undefined;

  if (socket && status === 'qr') {
    try {
      const code = await socket.requestPairingCode(normalized);
      currentPairingCode = `${code.slice(0, 4)}-${code.slice(4)}`;
      currentQr = undefined;
      currentQrSvg = undefined;
      status = 'pairing_code';
      log(`Código de conexão gerado para +${normalized}: ${currentPairingCode}`);
      return getBotSnapshot();
    } catch (error) {
      logError('Falha ao pedir código na sessão atual, reiniciando sessão:', error);
    }
  }

  await resetBotSession();
  return getBotSnapshot();
}

export async function switchToQrMode(): Promise<BotSnapshot> {
  config.pairingNumber = '';
  currentPairingCode = undefined;
  errorMessage = undefined;
  if (status === 'connected') {
    return getBotSnapshot();
  }
  await resetBotSession();
  return getBotSnapshot();
}

export async function updateBotConfig(partial: Partial<Pick<BotRuntimeConfig, 'allowedNumbers' | 'pairingNumber' | 'stickerPackName' | 'stickerPublisher' | 'debug'>>): Promise<BotSnapshot> {
  const nextPairing = partial.pairingNumber !== undefined ? normalizePairingPhone(partial.pairingNumber) : undefined;
  const pairingChanged = nextPairing !== undefined && nextPairing !== config.pairingNumber;
  if (partial.allowedNumbers !== undefined) {
    config.allowedNumbers = partial.allowedNumbers;
    refreshAllowed();
  }
  if (nextPairing !== undefined) {
    config.pairingNumber = nextPairing;
  }
  if (partial.stickerPackName !== undefined) {
    config.stickerPackName = partial.stickerPackName;
  }
  if (partial.stickerPublisher !== undefined) {
    config.stickerPublisher = partial.stickerPublisher;
  }
  if (partial.debug !== undefined) {
    config.debug = partial.debug;
  }
  log('Configuração atualizada.');
  if (pairingChanged && status !== 'connected' && status !== 'stopped') {
    await resetBotSession();
  }
  return getBotSnapshot();
}

export function getBotSnapshot(): BotSnapshot {
  return {
    status,
    qr: currentQr,
    qrSvg: currentQrSvg,
    pairingCode: currentPairingCode,
    user: connectedUser,
    errorMessage,
    toolProblems,
    warnings: allowedNumberWarnings(allowedList),
    queueSize: queue.size,
    stats: { ...stats },
    config: { ...config },
    logs: [...logs],
  };
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal} recebido: terminando o pedido em andamento antes de sair...`);
  clearTimeout(reconnectTimer);
  await Promise.race([queue.idle(), wait(15_000)]);
  socket?.end(undefined);
  process.exit(0);
}

const isDirectRun = Boolean(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href);

if (isDirectRun) {
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('unhandledRejection', error => logError('Erro não tratado:', error));
  await startBot({ standalone: true });
}
