import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, LoaderCircle, Upload, X, Play } from 'lucide-react';
import { useLanguage } from '../locales';
import { resilientFetch } from '../utils/api';

interface YouTubeUploadModalProps {
  fileName: string;
  initialTitle: string;
  initialDescription?: string;
  onClose: () => void;
}

interface ConnectionStatus {
  configured: boolean;
  connected: boolean;
  redirect_uri?: string;
}

interface BrowserConnectionStatus {
  available: boolean;
  browser_open: boolean;
  connected: boolean;
  busy: boolean;
  message?: string;
}

interface UploadJob {
  upload_id: string;
  status: 'queued' | 'uploading' | 'completed' | 'failed';
  progress_percent: number;
  message?: string;
  error?: string | null;
  watch_url?: string | null;
}

const YouTubeUploadModal: React.FC<YouTubeUploadModalProps> = ({
  fileName,
  initialTitle,
  initialDescription = '',
  onClose,
}) => {
  const { language } = useLanguage();
  const isId = language === 'id';
  const copy = isId
    ? {
        heading: 'Unggah ke YouTube',
        intro: 'Pilih uploader API yang sudah ada atau otomatisasi YouTube Studio dengan Playwright.',
        channel: 'Akun YouTube',
        checking: 'Memeriksa koneksi...',
        connected: 'Akun YouTube terhubung',
        notConnected: 'Akun belum terhubung',
        connect: 'Hubungkan YouTube',
        connecting: 'Menunggu otorisasi Google...',
        disconnect: 'Putuskan',
        title: 'Judul video',
        description: 'Deskripsi',
        tags: 'Tag (pisahkan dengan koma)',
        privacy: 'Privasi video',
        private: 'Pribadi',
        unlisted: 'Tidak publik',
        public: 'Publik',
        upload: 'Mulai unggah',
        uploading: 'Mengunggah...',
        progress: 'Progres unggahan',
        success: 'Video berhasil dikirim ke YouTube',
        openVideo: 'Buka video di YouTube',
        close: 'Tutup',
        setupTitle: 'Konfigurasi YouTube belum tersedia',
        setupText: 'Tambahkan YOUTUBE_CLIENT_ID dan YOUTUBE_CLIENT_SECRET ke backend/.env, lalu aktifkan YouTube Data API v3 di Google Cloud.',
        callback: 'Authorized redirect URI yang perlu didaftarkan:',
        publicWarning: 'Video publik dapat langsung dilihat siapa saja.',
        privateNote: 'Disetel ke Pribadi secara default agar aman. Anda dapat mengubahnya sebelum mengunggah.',
        defaultError: 'Terjadi kesalahan. Silakan coba lagi.',
        method: 'Metode unggah', apiMethod: 'YouTube API', browserMethod: 'Browser Upload (Playwright)',
        browserIntro: 'Gunakan browser khusus yang menyimpan sesi login YouTube.', browserOpen: 'Buka browser & login', browserOpening: 'Membuka browser...', browserConnected: 'Browser terhubung ke YouTube Studio', browserDisconnected: 'Browser belum login',
        madeForKids: 'Apakah video ini dibuat untuk anak-anak?', yesKids: 'Ya, dibuat untuk anak-anak', noKids: 'Tidak, bukan dibuat untuk anak-anak',
      }
    : {
        heading: 'Upload to YouTube',
        intro: 'Choose the existing API uploader or automate YouTube Studio with Playwright.',
        channel: 'YouTube account',
        checking: 'Checking connection...',
        connected: 'YouTube account connected',
        notConnected: 'Account not connected',
        connect: 'Connect YouTube',
        connecting: 'Waiting for Google authorization...',
        disconnect: 'Disconnect',
        title: 'Video title',
        description: 'Description',
        tags: 'Tags (comma separated)',
        privacy: 'Video privacy',
        private: 'Private',
        unlisted: 'Unlisted',
        public: 'Public',
        upload: 'Start upload',
        uploading: 'Uploading...',
        progress: 'Upload progress',
        success: 'Video successfully sent to YouTube',
        openVideo: 'Open video on YouTube',
        close: 'Close',
        setupTitle: 'YouTube setup is not configured',
        setupText: 'Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to backend/.env, then enable YouTube Data API v3 in Google Cloud.',
        callback: 'Add this Authorized redirect URI in Google Cloud:',
        publicWarning: 'Public videos can be viewed by anyone as soon as YouTube makes them available.',
        privateNote: 'Private is selected by default. Change this before uploading if needed.',
        defaultError: 'Something went wrong. Please try again.',
        method: 'Upload method', apiMethod: 'YouTube API', browserMethod: 'Browser Upload (Playwright)',
        browserIntro: 'Use a dedicated browser profile that keeps your YouTube sign-in session.', browserOpen: 'Open browser & sign in', browserOpening: 'Opening browser...', browserConnected: 'Browser connected to YouTube Studio', browserDisconnected: 'Browser is not signed in',
        madeForKids: 'Is this video made for kids?', yesKids: 'Yes, it is made for kids', noKids: 'No, it is not made for kids',
      };

  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [browser, setBrowser] = useState<BrowserConnectionStatus | null>(null);
  const [provider, setProvider] = useState<'api' | 'browser'>('api');
  const [madeForKids, setMadeForKids] = useState<'yes' | 'no'>('no');
  const [isOpeningBrowser, setIsOpeningBrowser] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [title, setTitle] = useState(initialTitle.slice(0, 100));
  const [description, setDescription] = useState(initialDescription);
  const [tags, setTags] = useState('');
  const [privacy, setPrivacy] = useState<'private' | 'unlisted' | 'public'>('private');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [error, setError] = useState('');

  const loadConnection = useCallback(async () => {
    const response = await resilientFetch('/api/youtube/status', {
      maxRetries: 1,
      silent: true,
    });
    if (!response.ok) throw new Error(copy.defaultError);
    const data = await response.json() as ConnectionStatus;
    setConnection(data);
    return data;
  }, [copy.defaultError]);

  const loadBrowserStatus = useCallback(async () => {
    const response = await resilientFetch('/api/youtube/browser/status', { maxRetries: 0, silent: true });
    if (!response.ok) throw new Error(copy.defaultError);
    const data = await response.json() as BrowserConnectionStatus;
    setBrowser(data);
    return data;
  }, [copy.defaultError]);

  useEffect(() => {
    let active = true;
    resilientFetch('/api/youtube/status', { maxRetries: 1, silent: true })
      .then(async (response) => {
        if (!response.ok) throw new Error(copy.defaultError);
        return await response.json() as ConnectionStatus;
      })
      .then((data) => { if (active) setConnection(data); })
      .catch((err) => { if (active) setError(err?.message || copy.defaultError); });
    loadBrowserStatus().catch(() => undefined);
    return () => { active = false; };
  }, [copy.defaultError, loadBrowserStatus]);

  useEffect(() => {
    if (!isOpeningBrowser) return;
    let active = true;
    const pollBrowser = async () => {
      try {
        const data = await loadBrowserStatus();
        if (active && data.connected) setIsOpeningBrowser(false);
      } catch { /* Keep checking while the browser starts. */ }
    };
    const interval = window.setInterval(pollBrowser, 1500);
    const timeout = window.setTimeout(() => { if (active) setIsOpeningBrowser(false); }, 180000);
    return () => { active = false; window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [isOpeningBrowser, loadBrowserStatus]);

  useEffect(() => {
    if (!isConnecting) return;
    let active = true;
    const pollConnection = async () => {
      try {
        const data = await loadConnection();
        if (active && data.connected) {
          setIsConnecting(false);
          setError('');
        }
      } catch {
        // Keep polling while the Google authorization popup is open.
      }
    };
    const interval = window.setInterval(pollConnection, 1800);
    const timeout = window.setTimeout(() => {
      if (active) setIsConnecting(false);
    }, 180000);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [isConnecting, loadConnection]);

  useEffect(() => {
    if (!job?.upload_id || job.status === 'completed' || job.status === 'failed') return;
    let active = true;
    const pollJob = async () => {
      try {
        const statusPath = provider === 'browser' ? '/api/youtube/browser/upload/' : '/api/youtube/upload/';
        const response = await resilientFetch(statusPath + job.upload_id, {
          maxRetries: 0,
          silent: true,
        });
        if (!response.ok) return;
        const data = await response.json() as UploadJob;
        if (active) setJob(data);
      } catch {
        // A temporary polling error should not interrupt the server-side upload.
      }
    };
    const interval = window.setInterval(pollJob, 1200);
    pollJob();
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [job?.upload_id, job?.status, provider]);

  const handleConnect = async () => {
    setError('');
    const popup = window.open('about:blank', 'cheatclip-youtube-oauth', 'popup,width=520,height=720');
    if (!popup) {
      setError(isId
        ? 'Popup diblokir browser. Izinkan popup untuk aplikasi ini lalu coba lagi.'
        : 'Your browser blocked the authorization popup. Allow popups for this app and try again.');
      return;
    }

    setIsConnecting(true);
    try {
      const response = await resilientFetch('/api/youtube/auth-url', { maxRetries: 0 });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || copy.defaultError);
      popup.location.href = data.authorization_url;
    } catch (err: any) {
      popup.close();
      setIsConnecting(false);
      setError(err?.message || copy.defaultError);
    }
  };

  const handleOpenBrowser = async () => {
    setError('');
    setIsOpeningBrowser(true);
    try {
      const response = await resilientFetch('/api/youtube/browser/connect', { method: 'POST', maxRetries: 0 });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || copy.defaultError);
      await loadBrowserStatus();
    } catch (err: any) {
      setIsOpeningBrowser(false);
      setError(err?.message || copy.defaultError);
    }
  };

  const handleDisconnect = async () => {
    setError('');
    try {
      const response = await resilientFetch('/api/youtube/disconnect', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || copy.defaultError);
      setConnection((current) => current ? { ...current, connected: false } : current);
      setJob(null);
    } catch (err: any) {
      setError(err?.message || copy.defaultError);
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((provider === 'api' && !connection?.connected) || (provider === 'browser' && !browser?.connected) || !title.trim() || isSubmitting) return;

    setError('');
    setIsSubmitting(true);
    setJob(null);
    try {
      const uploadPath = provider === 'browser' ? '/api/youtube/browser/upload' : '/api/youtube/upload';
      const response = await resilientFetch(uploadPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: fileName,
          title: title.trim(),
          description,
          tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
          privacy_status: privacy,
          ...(provider === 'browser' ? { made_for_kids: madeForKids === 'yes' } : {}),
        }),
        maxRetries: 0,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || copy.defaultError);
      setJob({
        upload_id: data.upload_id,
        status: data.status || 'queued',
        progress_percent: 0,
        message: data.status || 'Queued',
      });
    } catch (err: any) {
      setError(err?.message || copy.defaultError);
    } finally {
      setIsSubmitting(false);
    }
  };

  const uploading = job?.status === 'queued' || job?.status === 'uploading';
  const fieldStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: '#111522',
    color: '#f8fafc',
    border: '1px solid #343b4e',
    borderRadius: 9,
    padding: '10px 12px',
    font: 'inherit',
    fontSize: 13,
    outlineColor: '#8b5cf6',
  };
  const labelStyle: React.CSSProperties = {
    display: 'block',
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 6,
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !uploading) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(3, 6, 14, 0.78)',
        backdropFilter: 'blur(7px)',
        display: 'grid',
        placeItems: 'center',
        padding: 14,
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="youtube-upload-heading"
        style={{
          width: 'min(540px, 100%)',
          maxHeight: 'min(92vh, 780px)',
          overflowY: 'auto',
          background: '#171b29',
          color: '#f8fafc',
          border: '1px solid #343b4e',
          borderRadius: 16,
          boxShadow: '0 24px 80px rgba(0,0,0,.55)',
          padding: 20,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
          <div style={{ width: 42, height: 42, display: 'grid', placeItems: 'center', flex: '0 0 auto', borderRadius: 12, background: 'rgba(239,68,68,.14)', color: '#f87171' }}>
            <Play size={24} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id="youtube-upload-heading" style={{ fontSize: 18, margin: '1px 0 4px', fontWeight: 800 }}>{copy.heading}</h2>
            <p style={{ margin: 0, fontSize: 12, color: '#9ca3af', lineHeight: 1.5 }}>{copy.intro}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={copy.close} style={{ border: 0, background: 'transparent', color: '#94a3b8', cursor: 'pointer', padding: 4 }}>
            <X size={20} />
          </button>
        </header>

        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>{copy.method}</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {(['api', 'browser'] as const).map((value) => (
              <button key={value} type="button" onClick={() => { setProvider(value); setJob(null); setError(''); }}
                style={{ minHeight: 42, borderRadius: 9, border: provider === value ? '1px solid #a78bfa' : '1px solid #343b4e', background: provider === value ? 'rgba(139,92,246,.16)' : '#111522', color: '#f8fafc', fontWeight: 750, cursor: 'pointer' }}>
                {value === 'api' ? copy.apiMethod : copy.browserMethod}
              </button>
            ))}
          </div>
        </div>

        <div style={{ border: '1px solid #30384a', background: '#111522', borderRadius: 11, padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>{copy.channel}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: connection?.connected ? '#86efac' : '#e5e7eb' }}>
                {connection === null ? copy.checking : connection.connected ? copy.connected : copy.notConnected}
              </div>
            </div>
            {connection?.connected ? (
              <button type="button" onClick={handleDisconnect} style={{ border: '1px solid #485064', background: 'transparent', color: '#cbd5e1', borderRadius: 8, padding: '7px 10px', fontSize: 11, cursor: 'pointer' }}>
                {copy.disconnect}
              </button>
            ) : null}
          </div>

          {connection && !connection.configured ? (
            <div style={{ marginTop: 12, fontSize: 12, color: '#fbbf24', lineHeight: 1.55 }}>
              <strong>{copy.setupTitle}</strong>
              <p style={{ margin: '6px 0' }}>{copy.setupText}</p>
              <div style={{ color: '#cbd5e1', fontSize: 11 }}>{copy.callback}</div>
              <code style={{ display: 'block', marginTop: 5, padding: 8, background: '#090d16', borderRadius: 7, color: '#a5b4fc', overflowWrap: 'anywhere' }}>
                {connection.redirect_uri || 'http://localhost:8000/api/youtube/callback'}
              </code>
            </div>
          ) : null}

          {connection?.configured && !connection.connected ? (
            <button
              type="button"
              onClick={handleConnect}
              disabled={isConnecting}
              style={{ marginTop: 12, width: '100%', minHeight: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: 0, borderRadius: 9, background: '#dc2626', color: '#fff', fontWeight: 800, cursor: isConnecting ? 'wait' : 'pointer', opacity: isConnecting ? 0.75 : 1 }}
            >
              {isConnecting ? <LoaderCircle size={16} className="youtube-upload-spin" /> : <Play size={16} />}
              {isConnecting ? copy.connecting : copy.connect}
            </button>
          ) : null}
        </div>

        {provider === 'browser' ? (
          <div style={{ border: '1px solid #30384a', background: '#111522', borderRadius: 11, padding: 12, marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 5 }}>{copy.browserMethod}</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: browser?.connected ? '#86efac' : '#e5e7eb' }}>
              {browser?.connected ? copy.browserConnected : browser?.message || copy.browserDisconnected}
            </div>
            <p style={{ margin: '6px 0 10px', color: '#94a3b8', fontSize: 11 }}>{copy.browserIntro}</p>
            {!browser?.connected ? (
              <button type="button" onClick={handleOpenBrowser} disabled={isOpeningBrowser || browser?.available === false}
                style={{ width: '100%', minHeight: 40, border: 0, borderRadius: 9, background: '#2563eb', color: '#fff', fontWeight: 800, cursor: 'pointer', opacity: isOpeningBrowser ? .65 : 1 }}>
                {isOpeningBrowser ? <><LoaderCircle size={15} className="youtube-upload-spin" /> {copy.browserOpening}</> : copy.browserOpen}
              </button>
            ) : null}
          </div>
        ) : null}

        {((provider === 'api' && connection?.connected) || (provider === 'browser' && browser?.connected)) && !job?.upload_id ? (
          <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 13 }}>
            <div>
              <label htmlFor="youtube-upload-title" style={labelStyle}>{copy.title}</label>
              <input id="youtube-upload-title" value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} required style={fieldStyle} />
              <div style={{ textAlign: 'right', fontSize: 10, color: '#64748b', marginTop: 3 }}>{title.length}/100</div>
            </div>
            <div>
              <label htmlFor="youtube-upload-description" style={labelStyle}>{copy.description}</label>
              <textarea id="youtube-upload-description" value={description} maxLength={5000} onChange={(event) => setDescription(event.target.value)} rows={4} style={{ ...fieldStyle, resize: 'vertical' }} />
            </div>
            <div>
              <label htmlFor="youtube-upload-tags" style={labelStyle}>{copy.tags}</label>
              <input id="youtube-upload-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="gaming, highlights, shorts" style={fieldStyle} />
            </div>
            {provider === 'browser' ? (
              <div>
                <label htmlFor="youtube-made-for-kids" style={labelStyle}>{copy.madeForKids}</label>
                <select id="youtube-made-for-kids" value={madeForKids} onChange={(event) => setMadeForKids(event.target.value as 'yes' | 'no')} style={fieldStyle}>
                  <option value="no">{copy.noKids}</option>
                  <option value="yes">{copy.yesKids}</option>
                </select>
              </div>
            ) : null}
            <div>
              <label htmlFor="youtube-upload-privacy" style={labelStyle}>{copy.privacy}</label>
              <select id="youtube-upload-privacy" value={privacy} onChange={(event) => setPrivacy(event.target.value as 'private' | 'unlisted' | 'public')} style={fieldStyle}>
                <option value="private">{copy.private}</option>
                <option value="unlisted">{copy.unlisted}</option>
                <option value="public">{copy.public}</option>
              </select>
              <p style={{ margin: '6px 0 0', fontSize: 11, color: '#94a3b8' }}>{privacy === 'public' ? copy.publicWarning : copy.privateNote}</p>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', overflowWrap: 'anywhere' }}>
              MP4 file: <strong style={{ color: '#e2e8f0' }}>{fileName}</strong>
            </div>
            <button type="submit" disabled={!title.trim() || isSubmitting} style={{ minHeight: 42, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, border: 0, borderRadius: 9, background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 800, cursor: isSubmitting ? 'wait' : 'pointer', opacity: isSubmitting ? 0.7 : 1 }}>
              {isSubmitting ? <LoaderCircle size={16} className="youtube-upload-spin" /> : <Upload size={16} />}
              {isSubmitting ? copy.uploading : copy.upload}
            </button>
          </form>
        ) : null}

        {uploading ? (
          <div style={{ border: '1px solid #30384a', background: '#111522', borderRadius: 11, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
              <LoaderCircle size={16} className="youtube-upload-spin" color="#f87171" />
              {copy.uploading}
            </div>
            <div style={{ height: 9, background: '#30384a', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: String(Math.max(0, Math.min(100, job?.progress_percent || 0))) + '%', background: '#ef4444', borderRadius: 99, transition: 'width .2s ease' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 7, fontSize: 11, color: '#9ca3af' }}>
              <span>{copy.progress}</span>
              <strong style={{ color: '#f8fafc' }}>{job?.progress_percent || 0}%</strong>
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 11, color: '#9ca3af' }}>{job?.message || copy.uploading}</p>
          </div>
        ) : null}

        {job?.status === 'completed' ? (
          <div style={{ border: '1px solid rgba(34,197,94,.35)', background: 'rgba(34,197,94,.08)', borderRadius: 11, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#86efac', fontWeight: 800, fontSize: 13 }}>
              <CheckCircle2 size={18} /> {copy.success}
            </div>
            <a href={job.watch_url || '#'} target="_blank" rel="noopener noreferrer" style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 7, color: '#fca5a5', fontSize: 13, fontWeight: 800, textDecoration: 'none' }}>
              {copy.openVideo} <ExternalLink size={14} />
            </a>
          </div>
        ) : null}

        {job?.status === 'failed' ? (
          <div style={{ border: '1px solid rgba(239,68,68,.4)', background: 'rgba(239,68,68,.08)', borderRadius: 11, padding: 12, color: '#fca5a5', fontSize: 12 }}>
            {job.error || copy.defaultError}
            <button type="button" onClick={() => setJob(null)} style={{ display: 'block', marginTop: 10, border: '1px solid #7f1d1d', background: 'transparent', color: '#fecaca', borderRadius: 7, padding: '6px 10px', cursor: 'pointer' }}>
              {isId ? 'Coba lagi' : 'Try again'}
            </button>
          </div>
        ) : null}

        {error ? (
          <div role="alert" style={{ marginTop: 12, padding: 10, borderRadius: 8, border: '1px solid rgba(248,113,113,.35)', background: 'rgba(239,68,68,.08)', color: '#fca5a5', fontSize: 12, lineHeight: 1.5 }}>
            {error}
          </div>
        ) : null}

        <footer style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" onClick={onClose} style={{ border: '1px solid #3b4356', background: 'transparent', color: '#e2e8f0', borderRadius: 9, padding: '8px 14px', fontWeight: 700, cursor: 'pointer' }}>
            {copy.close}
          </button>
        </footer>
      </section>
      <style>{'@keyframes youtubeUploadSpin { to { transform: rotate(360deg); } } .youtube-upload-spin { animation: youtubeUploadSpin 1s linear infinite; } @media (prefers-reduced-motion: reduce) { .youtube-upload-spin { animation: none; } }'}</style>
    </div>
  );
};

export default YouTubeUploadModal;
