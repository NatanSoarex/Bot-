import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  FileVideo,
  Link as LinkIcon,
  Loader2,
  Play,
  QrCode,
  RefreshCw,
  RotateCcw,
  Settings,
  Smartphone,
  Square,
  Terminal,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';

type BotConnectionStatus =
  | 'idle'
  | 'starting'
  | 'qr'
  | 'pairing_code'
  | 'connected'
  | 'reconnecting'
  | 'logged_out'
  | 'error'
  | 'stopped';

type BotLogEntry = {
  id: number;
  time: string;
  level: 'info' | 'error';
  message: string;
};

type BotSnapshot = {
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
  config: {
    allowedNumbers: string;
    pairingNumber: string;
    stickerPackName: string;
    stickerPublisher: string;
    debug: boolean;
    maxPending: number;
    authDir: string;
  };
  logs: BotLogEntry[];
};

type ConvertResult = {
  stickerBase64: string;
  stickerBytes: number;
  audioBase64?: string;
  audioBytes: number;
  animated: boolean;
  durationMs: number;
  trimmed: boolean;
  startSeconds?: number;
  clipSeconds?: number;
  hasAudio: boolean;
  audioSilent: boolean;
  audioError?: string;
};

const STATUS_LABEL: Record<BotConnectionStatus, { text: string; dot: string; badge: string }> = {
  idle: { text: 'Iniciando', dot: 'bg-stone-400', badge: 'bg-stone-100 text-stone-700 border-stone-200' },
  starting: { text: 'Conectando ao WhatsApp…', dot: 'bg-amber-500 animate-pulse', badge: 'bg-amber-50 text-amber-800 border-amber-200' },
  qr: { text: 'Aguardando leitura do QR', dot: 'bg-amber-500 animate-pulse', badge: 'bg-amber-50 text-amber-800 border-amber-200' },
  pairing_code: { text: 'Aguardando código no celular', dot: 'bg-amber-500 animate-pulse', badge: 'bg-amber-50 text-amber-800 border-amber-200' },
  connected: { text: 'Conectado', dot: 'bg-[#1a7f37]', badge: 'bg-emerald-50 text-[#1a7f37] border-emerald-200' },
  reconnecting: { text: 'Reconectando…', dot: 'bg-amber-500 animate-pulse', badge: 'bg-amber-50 text-amber-800 border-amber-200' },
  logged_out: { text: 'Desconectado pelo celular', dot: 'bg-red-600', badge: 'bg-red-50 text-red-700 border-red-200' },
  error: { text: 'Erro de conexão', dot: 'bg-red-600', badge: 'bg-red-50 text-red-700 border-red-200' },
  stopped: { text: 'Pausado', dot: 'bg-stone-400', badge: 'bg-stone-100 text-stone-700 border-stone-200' },
};

function base64ToBlobUrl(base64: string, mime: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export default function App() {
  const [snapshot, setSnapshot] = useState<BotSnapshot | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // Config form state
  const [allowedNumbers, setAllowedNumbers] = useState('');
  const [pairingNumber, setPairingNumber] = useState('');
  const [packName, setPackName] = useState('Criada por Dexter');
  const [publisher, setPublisher] = useState('');
  const [debugMode, setDebugMode] = useState(false);
  const [configSynced, setConfigSynced] = useState(false);
  const [configSavedNotice, setConfigSavedNotice] = useState(false);

  // Link method tab
  const [linkMethod, setLinkMethod] = useState<'qr' | 'code'>('qr');
  const [pairPhoneInput, setPairPhoneInput] = useState('');
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairCopied, setPairCopied] = useState(false);

  // Converter state
  const [sourceMode, setSourceMode] = useState<'file' | 'link'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [fitMode, setFitMode] = useState<'cortar' | 'inteiro'>('cortar');
  const [withAudio, setWithAudio] = useState(true);
  const [clipRange, setClipRange] = useState('');
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertResult, setConvertResult] = useState<ConvertResult | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bot/status', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as BotSnapshot;
      setSnapshot(data);
      if (!configSynced) {
        setAllowedNumbers(data.config.allowedNumbers);
        setPairingNumber(data.config.pairingNumber);
        setPairPhoneInput(data.config.pairingNumber);
        if (data.config.pairingNumber) setLinkMethod('code');
        setPackName(data.config.stickerPackName);
        setPublisher(data.config.stickerPublisher);
        setDebugMode(data.config.debug);
        setConfigSynced(true);
      }
    } catch {
      // ignora erro transitório de polling
    }
  }, [configSynced]);

  useEffect(() => {
    void fetchStatus();
    const timer = setInterval(() => {
      void fetchStatus();
    }, 1500);
    return () => clearInterval(timer);
  }, [fetchStatus]);

  const qrImgUrl = useMemo(() => {
    if (!snapshot?.qrSvg) return null;
    return `data:image/svg+xml;utf8,${encodeURIComponent(snapshot.qrSvg)}`;
  }, [snapshot?.qrSvg]);

  const previewUrls = useMemo(() => {
    if (!convertResult) return null;
    const webpUrl = base64ToBlobUrl(convertResult.stickerBase64, 'image/webp');
    const audioUrl = convertResult.audioBase64
      ? base64ToBlobUrl(convertResult.audioBase64, 'audio/ogg; codecs=opus')
      : undefined;
    return { webpUrl, audioUrl };
  }, [convertResult]);

  useEffect(() => {
    return () => {
      if (previewUrls?.webpUrl) URL.revokeObjectURL(previewUrls.webpUrl);
      if (previewUrls?.audioUrl) URL.revokeObjectURL(previewUrls.audioUrl);
    };
  }, [previewUrls]);

  async function runBotAction(endpoint: string, body?: Record<string, unknown>) {
    setActionBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        const data = (await res.json()) as BotSnapshot;
        setSnapshot(data);
      }
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    await runBotAction('/api/bot/config', {
      allowedNumbers,
      pairingNumber,
      stickerPackName: packName,
      stickerPublisher: publisher,
      debug: debugMode,
    });
    setConfigSavedNotice(true);
    setTimeout(() => setConfigSavedNotice(false), 2500);
  }

  async function handleRequestPairingCode(e: React.FormEvent) {
    e.preventDefault();
    setPairError(null);
    setActionBusy(true);
    try {
      const res = await fetch('/api/bot/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: pairPhoneInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setPairError(data.error || 'Não foi possível gerar o código.');
        return;
      }
      const snap = data as BotSnapshot;
      setSnapshot(snap);
      setPairingNumber(snap.config.pairingNumber);
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'Erro ao solicitar código.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleSwitchToQr() {
    setPairError(null);
    setLinkMethod('qr');
    setPairingNumber('');
    await runBotAction('/api/bot/qr-mode');
  }

  async function handleCopyPairingCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setPairCopied(true);
      setTimeout(() => setPairCopied(false), 2000);
    } catch {
      // ignora se clipboard bloqueado
    }
  }

  async function handleConvert(useSample = false) {
    setConverting(true);
    setConvertError(null);
    try {
      let res: Response;
      if (useSample) {
        res = await fetch('/api/convert/sample', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fit: fitMode, withAudio, clip: clipRange }),
        });
      } else if (sourceMode === 'link') {
        res = await fetch('/api/convert/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: linkUrl,
            fit: fitMode,
            withAudio,
            clip: clipRange,
            packName,
            publisher,
          }),
        });
      } else {
        if (!selectedFile) {
          setConvertError('Selecione um arquivo de vídeo, GIF ou imagem.');
          setConverting(false);
          return;
        }
        const params = new URLSearchParams({
          fit: fitMode,
          withAudio: String(withAudio),
          packName,
          publisher,
        });
        if (clipRange.trim()) params.set('clip', clipRange.trim());
        const kind = selectedFile.type.startsWith('image/') && selectedFile.type !== 'image/gif' ? 'image' : 'video';
        params.set('kind', kind);

        res = await fetch(`/api/convert/file?${params.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': selectedFile.type || 'application/octet-stream',
          },
          body: selectedFile,
        });
      }

      const data = await res.json();
      if (!res.ok) {
        setConvertError(data.error || 'Falha na conversão.');
        return;
      }
      setConvertResult(data as ConvertResult);
    } catch (error) {
      setConvertError(error instanceof Error ? error.message : 'Erro ao converter.');
    } finally {
      setConverting(false);
    }
  }

  const statusMeta = STATUS_LABEL[snapshot?.status ?? 'idle'];
  const phoneDisplay = snapshot?.user?.id ? snapshot.user.id.split(':')[0] : undefined;

  return (
    <div className="min-h-screen bg-[#f4f4f2] text-[#1d1d1b] font-sans antialiased">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#1a7f37] text-white">
              <Volume2 className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-[#1d1d1b]">
                Bot-fig — Figurinhas com Som
              </h1>
              <p className="text-xs text-stone-500">
                WhatsApp bot (Baileys + FFmpeg) para figurinhas WebP animadas com áudio Ogg/Opus
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <span className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium ${statusMeta.badge}`}>
              <span className={`h-2 w-2 rounded-full ${statusMeta.dot}`} />
              {statusMeta.text}
            </span>

            {snapshot?.status === 'stopped' ? (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => runBotAction('/api/bot/start')}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#1a7f37] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#15692d] disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                Iniciar bot
              </button>
            ) : (
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => runBotAction('/api/bot/stop')}
                className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                <Square className="h-3.5 w-3.5" />
                Parar
              </button>
            )}

            <button
              type="button"
              disabled={actionBusy}
              onClick={() => runBotAction('/api/bot/restart')}
              className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reconectar
            </button>

            <button
              type="button"
              disabled={actionBusy}
              onClick={() => runBotAction('/api/bot/reset-session')}
              title="Apaga a pasta da sessão e gera um novo QR code"
              className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-red-50 hover:text-red-700 hover:border-red-200 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Nova sessão
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-6 lg:grid-cols-12">
        {/* Coluna Esquerda: Vinculação WhatsApp + Comandos + Configurações */}
        <section className="space-y-6 lg:col-span-5">
          <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <QrCode className="h-4 w-4 text-[#1a7f37]" />
                Vincular WhatsApp
              </h2>
              {snapshot && (
                <span className="text-xs text-stone-500">
                  Fila: {snapshot.queueSize}/{snapshot.config.maxPending}
                </span>
              )}
            </div>

            {snapshot?.toolProblems && snapshot.toolProblems.length > 0 && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                <p className="font-semibold">Problemas no FFmpeg:</p>
                <ul className="mt-1 list-disc pl-4">
                  {snapshot.toolProblems.map((p, idx) => (
                    <li key={idx}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            {snapshot?.errorMessage && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800 whitespace-pre-line">
                {snapshot.errorMessage}
              </div>
            )}

            {snapshot?.status === 'connected' ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                  <CheckCircle2 className="h-6 w-6 shrink-0 text-[#1a7f37]" />
                  <div>
                    <p className="text-sm font-semibold text-[#1a7f37]">
                      Bot conectado{snapshot.user?.name ? ` (${snapshot.user.name})` : ''}
                    </p>
                    <p className="text-xs text-emerald-900/80">
                      {phoneDisplay ? `Número: +${phoneDisplay}` : 'Sessão ativa e pronta para receber comandos.'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg border border-stone-200 bg-[#f4f4f2] p-2.5">
                    <div className="text-lg font-semibold text-[#1d1d1b]">
                      {snapshot.stats.soundStickersSent}
                    </div>
                    <div className="text-[11px] text-stone-500">Com som</div>
                  </div>
                  <div className="rounded-lg border border-stone-200 bg-[#f4f4f2] p-2.5">
                    <div className="text-lg font-semibold text-[#1d1d1b]">
                      {snapshot.stats.plainStickersSent}
                    </div>
                    <div className="text-[11px] text-stone-500">Sem som</div>
                  </div>
                  <div className="rounded-lg border border-stone-200 bg-[#f4f4f2] p-2.5">
                    <div className="text-lg font-semibold text-[#1d1d1b]">
                      {snapshot.stats.errors}
                    </div>
                    <div className="text-[11px] text-stone-500">Erros</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-stone-200 bg-[#f4f4f2] p-1">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => {
                      if (snapshot?.config.pairingNumber) {
                        void handleSwitchToQr();
                      } else {
                        setLinkMethod('qr');
                      }
                    }}
                    className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                      linkMethod === 'qr' && snapshot?.status !== 'pairing_code'
                        ? 'bg-white text-[#1d1d1b] shadow-xs'
                        : 'text-stone-600 hover:text-[#1d1d1b]'
                    }`}
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    QR Code
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setLinkMethod('code')}
                    className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                      linkMethod === 'code' || snapshot?.status === 'pairing_code'
                        ? 'bg-white text-[#1d1d1b] shadow-xs'
                        : 'text-stone-600 hover:text-[#1d1d1b]'
                    }`}
                  >
                    <Smartphone className="h-3.5 w-3.5" />
                    Código por telefone
                  </button>
                </div>

                {linkMethod === 'code' || snapshot?.status === 'pairing_code' ? (
                  <div className="space-y-4">
                    <form onSubmit={handleRequestPairingCode} className="space-y-2.5">
                      <label className="block text-xs font-medium text-stone-700">
                        Número do WhatsApp do bot (com DDD)
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="tel"
                          value={pairPhoneInput}
                          onChange={e => setPairPhoneInput(e.target.value)}
                          placeholder="Ex.: 5511999998888 ou 11999998888"
                          className="w-full rounded-md border border-stone-300 px-3 py-2 text-xs focus:border-[#1a7f37] focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={actionBusy || !pairPhoneInput.trim()}
                          className="shrink-0 rounded-md bg-[#1a7f37] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#15692d] disabled:opacity-50"
                        >
                          {actionBusy ? 'Gerando…' : snapshot?.pairingCode ? 'Gerar outro' : 'Gerar código'}
                        </button>
                      </div>
                      <p className="text-[11px] text-stone-500">
                        Para números do Brasil, se você digitar só DDD + número (ex.: 11999998888), adicionamos o +55 automaticamente.
                      </p>
                      {pairError && (
                        <p className="text-xs text-red-700">{pairError}</p>
                      )}
                    </form>

                    {snapshot?.pairingCode ? (
                      <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 text-center space-y-2">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-[#1a7f37]">
                          Digite este código no WhatsApp
                        </p>
                        <div className="flex items-center justify-center gap-2">
                          <span className="font-mono text-3xl font-bold tracking-widest text-[#1d1d1b]">
                            {snapshot.pairingCode}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyPairingCode(snapshot.pairingCode!)}
                            title="Copiar código"
                            className="rounded-md border border-stone-300 bg-white p-1.5 text-stone-700 hover:bg-stone-50"
                          >
                            {pairCopied ? <Check className="h-4 w-4 text-[#1a7f37]" /> : <Copy className="h-4 w-4" />}
                          </button>
                        </div>
                        {snapshot.config.pairingNumber && (
                          <p className="text-[11px] text-stone-600">
                            Solicitado para +{snapshot.config.pairingNumber}
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="rounded-lg border border-stone-200 bg-[#f4f4f2] p-4 text-center text-xs text-stone-500">
                        Informe o número acima e clique em <strong>Gerar código</strong>.
                      </div>
                    )}

                    <ol className="space-y-1 text-xs text-stone-600 list-decimal pl-4">
                      <li>No celular do bot, abra o WhatsApp.</li>
                      <li>Vá em <strong>Configurações › Aparelhos conectados › Conectar um aparelho</strong>.</li>
                      <li>Toque em <strong>Conectar com número de telefone</strong> na parte inferior da tela.</li>
                      <li>Digite o código de 8 caracteres exibido acima.</li>
                    </ol>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-stone-200 bg-[#f4f4f2] p-4">
                      {qrImgUrl ? (
                        <div className="rounded-lg bg-white p-3 shadow-xs">
                          <img
                            src={qrImgUrl}
                            alt="QR Code para vincular o bot no WhatsApp"
                            className="h-56 w-56 block"
                          />
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-2 text-xs text-stone-500">
                          <Loader2 className="h-5 w-5 animate-spin text-stone-400" />
                          <span>
                            {snapshot?.status === 'stopped'
                              ? 'Bot pausado. Clique em "Iniciar bot" para gerar o QR.'
                              : snapshot?.status === 'logged_out'
                                ? 'Sessão encerrada. Clique em "Nova sessão" para gerar outro QR.'
                                : 'Aguardando QR code do WhatsApp…'}
                          </span>
                        </div>
                      )}
                    </div>

                    <ol className="space-y-1 text-xs text-stone-600 list-decimal pl-4">
                      <li>No celular do bot, abra o WhatsApp.</li>
                      <li>Vá em <strong>Configurações › Aparelhos conectados › Conectar um aparelho</strong>.</li>
                      <li>Aponte a câmera para o QR acima (atualiza sozinho a cada ~20 s).</li>
                    </ol>
                  </div>
                )}
              </div>
            )}

            <div className="mt-5 border-t border-stone-200 pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-500">
                Comandos no WhatsApp
              </p>
              <div className="space-y-1.5 text-xs text-stone-700">
                <p><code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono">!som</code> — vídeo, resposta a vídeo ou link (TikTok, Instagram, YouTube) → figurinha com som</p>
                <p><code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono">!som 0:42-0:47</code> — recorta exatamente o trecho desejado (até 10 s)</p>
                <p><code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono">!som inteiro</code> — mantém o quadro todo com bordas transparentes</p>
                <p><code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono">!fig</code> — figurinha comum (sem som) de foto, vídeo, GIF ou link</p>
                <p><code className="rounded bg-stone-100 px-1.5 py-0.5 font-mono">!ajuda</code> — envia as instruções no chat</p>
              </div>
            </div>
          </div>

          {/* Configurações em tempo real */}
          <form onSubmit={handleSaveConfig} className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Settings className="h-4 w-4 text-stone-600" />
                Configurações
              </h2>
              {configSavedNotice && (
                <span className="text-xs font-medium text-[#1a7f37]">Salvo!</span>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-stone-700">
                Números permitidos (<code className="font-mono">ALLOWED_NUMBERS</code>)
              </label>
              <div className="mt-1 flex gap-1.5">
                <input
                  type="text"
                  value={allowedNumbers}
                  onChange={e => setAllowedNumbers(e.target.value)}
                  placeholder="Vazio = todos, 0 = só você, ou 5511999998888"
                  className="w-full rounded-md border border-stone-300 px-2.5 py-1.5 text-xs focus:border-[#1a7f37] focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setAllowedNumbers('0')}
                  className="shrink-0 rounded-md border border-stone-300 px-2 py-1 text-[11px] text-stone-600 hover:bg-stone-50"
                >
                  Só eu (0)
                </button>
                <button
                  type="button"
                  onClick={() => setAllowedNumbers('')}
                  className="shrink-0 rounded-md border border-stone-300 px-2 py-1 text-[11px] text-stone-600 hover:bg-stone-50"
                >
                  Todos
                </button>
              </div>
              {snapshot?.warnings && snapshot.warnings.length > 0 && (
                <p className="mt-1 text-[11px] text-amber-700">{snapshot.warnings[0]}</p>
              )}
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-xs font-medium text-stone-700">
                <Smartphone className="h-3.5 w-3.5 text-stone-400" />
                Conectar com número em vez de QR (<code className="font-mono">NUMERO_CONEXAO</code>)
              </label>
              <input
                type="text"
                value={pairingNumber}
                onChange={e => setPairingNumber(e.target.value)}
                placeholder="Ex.: 5511999998888 (deixe vazio para usar QR)"
                className="mt-1 w-full rounded-md border border-stone-300 px-2.5 py-1.5 text-xs focus:border-[#1a7f37] focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-700">Nome do pacote</label>
                <input
                  type="text"
                  value={packName}
                  onChange={e => setPackName(e.target.value)}
                  className="mt-1 w-full rounded-md border border-stone-300 px-2.5 py-1.5 text-xs focus:border-[#1a7f37] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700">Autor (opcional)</label>
                <input
                  type="text"
                  value={publisher}
                  onChange={e => setPublisher(e.target.value)}
                  className="mt-1 w-full rounded-md border border-stone-300 px-2.5 py-1.5 text-xs focus:border-[#1a7f37] focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 text-xs text-stone-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={debugMode}
                  onChange={e => setDebugMode(e.target.checked)}
                  className="rounded border-stone-300 accent-[#1a7f37]"
                />
                Modo DEBUG (registra etapas e chegadas)
              </label>

              <button
                type="submit"
                disabled={actionBusy}
                className="rounded-md bg-[#1d1d1b] px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              >
                Aplicar configurações
              </button>
            </div>
          </form>
        </section>

        {/* Coluna Direita: Conversor Local + Logs */}
        <section className="space-y-6 lg:col-span-7">
          <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <FileVideo className="h-4 w-4 text-[#1a7f37]" />
                  Conversor Local (sem WhatsApp)
                </h2>
                <p className="text-xs text-stone-500">
                  Usa o mesmo motor do bot (<code className="font-mono">src/convert.ts</code>) para gerar WebP 512×512 + Ogg/Opus.
                </p>
              </div>
              <button
                type="button"
                disabled={converting}
                onClick={() => handleConvert(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-[#f4f4f2] px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-200/70 disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Testar exemplo (lhama)
              </button>
            </div>

            <div className="flex gap-2 border-b border-stone-200 pb-3">
              <button
                type="button"
                onClick={() => setSourceMode('file')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                  sourceMode === 'file'
                    ? 'bg-[#1d1d1b] text-white'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
                }`}
              >
                <Upload className="h-3.5 w-3.5" />
                Arquivo (vídeo, GIF, foto)
              </button>
              <button
                type="button"
                onClick={() => setSourceMode('link')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
                  sourceMode === 'link'
                    ? 'bg-[#1d1d1b] text-white'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
                }`}
              >
                <LinkIcon className="h-3.5 w-3.5" />
                Link (YouTube, TikTok, Instagram)
              </button>
            </div>

            {sourceMode === 'file' ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 bg-[#f4f4f2]/70 px-4 py-6 text-center hover:border-[#1a7f37]"
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,image/*"
                  onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
                  className="hidden"
                />
                <Upload className="mb-2 h-5 w-5 text-stone-500" />
                {selectedFile ? (
                  <p className="text-xs font-medium text-[#1d1d1b]">
                    {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                ) : (
                  <p className="text-xs text-stone-600">
                    Clique para escolher um vídeo, GIF ou foto (até 16 MB)
                  </p>
                )}
              </div>
            ) : (
              <div>
                <input
                  type="url"
                  value={linkUrl}
                  onChange={e => setLinkUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=... ou TikTok / Instagram Reel"
                  className="w-full rounded-md border border-stone-300 px-3 py-2 text-xs focus:border-[#1a7f37] focus:outline-none"
                />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-stone-700">Enquadramento</label>
                <select
                  value={fitMode}
                  onChange={e => setFitMode(e.target.value as 'cortar' | 'inteiro')}
                  className="mt-1 w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-xs focus:border-[#1a7f37] focus:outline-none"
                >
                  <option value="cortar">Cortar (preenche 512×512)</option>
                  <option value="inteiro">Inteiro (bordas transparentes)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700">Trecho (opcional)</label>
                <input
                  type="text"
                  value={clipRange}
                  onChange={e => setClipRange(e.target.value)}
                  placeholder="Ex.: 0:12 ou 0:12-0:17"
                  className="mt-1 w-full rounded-md border border-stone-300 px-2.5 py-1.5 text-xs focus:border-[#1a7f37] focus:outline-none"
                />
              </div>

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => setWithAudio(v => !v)}
                  className={`flex w-full items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium ${
                    withAudio
                      ? 'border-emerald-200 bg-emerald-50 text-[#1a7f37]'
                      : 'border-stone-300 bg-stone-50 text-stone-600'
                  }`}
                >
                  {withAudio ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                  {withAudio ? 'Com som (!som)' : 'Sem som (!fig)'}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              {convertError ? (
                <p className="text-xs text-red-700">{convertError}</p>
              ) : (
                <span className="text-xs text-stone-500">
                  Limite WhatsApp: WebP animado até 500 KB, duração até 10 s.
                </span>
              )}

              <button
                type="button"
                disabled={converting}
                onClick={() => handleConvert(false)}
                className="inline-flex items-center gap-2 rounded-md bg-[#1a7f37] px-4 py-2 text-xs font-medium text-white hover:bg-[#15692d] disabled:opacity-50"
              >
                {converting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Convertendo…
                  </>
                ) : (
                  'Gerar figurinha'
                )}
              </button>
            </div>

            {convertResult && previewUrls && (
              <div className="mt-2 grid gap-4 rounded-lg border border-stone-200 bg-[#f4f4f2] p-4 sm:grid-cols-12">
                <div className="flex items-center justify-center rounded-md border border-stone-200 bg-white p-2 sm:col-span-5">
                  <img
                    src={previewUrls.webpUrl}
                    alt="Prévia da figurinha WebP 512x512"
                    className="h-40 w-40 object-contain"
                  />
                </div>
                <div className="flex flex-col justify-between space-y-3 sm:col-span-7">
                  <div className="space-y-1 text-xs">
                    <p className="font-semibold text-[#1d1d1b]">
                      Figurinha pronta ({(convertResult.stickerBytes / 1024).toFixed(0)} KB • {(convertResult.durationMs / 1000).toFixed(2)} s)
                    </p>
                    <p className="text-stone-600">
                      {convertResult.animated ? 'WebP animado 512×512' : 'WebP estático 512×512'}
                      {convertResult.trimmed ? ' • cortada em 10 s' : ''}
                    </p>
                    {convertResult.hasAudio ? (
                      convertResult.audioSilent ? (
                        <p className="text-amber-700">Faixa de áudio está muda (enviada sem som).</p>
                      ) : convertResult.audioError ? (
                        <p className="text-red-700">Falha no áudio: {convertResult.audioError}</p>
                      ) : previewUrls.audioUrl ? (
                        <div className="pt-1">
                          <p className="mb-1 text-[11px] text-stone-500">
                            Áudio Ogg/Opus ({(convertResult.audioBytes / 1024).toFixed(0)} KB):
                          </p>
                          <audio controls src={previewUrls.audioUrl} className="h-8 w-full" />
                        </div>
                      ) : (
                        <p className="text-stone-500">Modo !fig (áudio não extraído).</p>
                      )
                    ) : (
                      <p className="text-stone-500">Mídia sem faixa de áudio.</p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <a
                      href={previewUrls.webpUrl}
                      download="figurinha.webp"
                      className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:bg-stone-50"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Baixar .webp
                    </a>
                    {previewUrls.audioUrl && (
                      <a
                        href={previewUrls.audioUrl}
                        download="figurinha.ogg"
                        className="inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-800 hover:bg-stone-50"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Baixar .ogg
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Logs */}
          <div className="rounded-xl border border-stone-200 bg-white p-5 shadow-xs">
            <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
              <Terminal className="h-4 w-4 text-stone-600" />
              Atividade do Bot
            </h2>
            <div className="h-60 overflow-y-auto rounded-lg border border-stone-200 bg-[#1d1d1b] p-3 font-mono text-xs text-stone-200">
              {snapshot?.logs && snapshot.logs.length > 0 ? (
                <ul className="space-y-1">
                  {snapshot.logs.map(entry => (
                    <li key={entry.id} className={entry.level === 'error' ? 'text-red-300' : 'text-stone-200'}>
                      <span className="text-stone-500">[{entry.time}]</span> {entry.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-stone-500">Aguardando eventos…</p>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
