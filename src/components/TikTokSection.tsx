import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, LoaderCircle, Play, Upload } from 'lucide-react';
import type { BatchRenderProgress } from '../types';
import { resilientFetch } from '../utils/api';

interface TikTokSectionProps { batchProgress: BatchRenderProgress | null; }
interface ConnectionStatus { configured: boolean; connected: boolean; redirect_uri?: string; scope?: string; }
interface UploadJob {
  upload_id: string;
  status: 'queued' | 'uploading' | 'processing' | 'completed' | 'failed';
  progress_percent: number;
  message?: string;
  error?: string | null;
}

export const TikTokSection: React.FC<TikTokSectionProps> = ({ batchProgress }) => {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [preparingClip, setPreparingClip] = useState<number | null>(null);
  const [activeClipIndex, setActiveClipIndex] = useState<number | null>(null);
  const [job, setJob] = useState<UploadJob | null>(null);
  const [error, setError] = useState('');
  const isId = document.documentElement.lang === 'id';

  const words = isId ? {
    subtitle: 'Hubungkan akun TikTok untuk mengirim hasil Auto Clipper sebagai draft.',
    checking: 'Memeriksa koneksi...', connect: 'Hubungkan TikTok', connecting: 'Menunggu otorisasi TikTok...',
    connected: 'Akun TikTok terhubung', disconnect: 'Putuskan', configTitle: 'TikTok belum dikonfigurasi',
    configText: 'Tambahkan TIKTOK_CLIENT_KEY dan TIKTOK_CLIENT_SECRET ke backend/.env. Daftarkan aplikasi Desktop di TikTok for Developers, aktifkan Login Kit dan Content Posting API, lalu setujui scope video.upload.',
    redirect: 'Redirect URI:', videos: 'Video hasil render', videosHint: 'Video yang selesai dirender pada batch Auto Clipper terakhir.',
    ready: 'siap', empty: 'Belum ada video selesai.', emptyHint: 'Render klip di Auto Clipper dan video akan muncul di sini.',
    upload: 'Kirim ke TikTok', preparing: 'Menyiapkan...', connectFirst: 'Hubungkan akun TikTok sebelum mengunggah.',
    inboxNote: 'Video dikirim sebagai draft. Buka notifikasi di kotak masuk TikTok untuk menambahkan caption dan memublikasikannya.',
    completed: 'Upload diterima TikTok', failed: 'Upload gagal', defaultError: 'Terjadi kesalahan. Coba lagi.',
  } : {
    subtitle: 'Connect your TikTok account to send finished Auto Clipper videos as drafts.',
    checking: 'Checking connection...', connect: 'Connect TikTok', connecting: 'Waiting for TikTok authorization...',
    connected: 'TikTok account connected', disconnect: 'Disconnect', configTitle: 'TikTok is not configured',
    configText: 'Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to backend/.env. Register a Desktop app in TikTok for Developers, add Login Kit and Content Posting API, then approve the video.upload scope.',
    redirect: 'Register this redirect URI:', videos: 'Rendered videos', videosHint: 'Videos completed in your latest Auto Clipper render batch.',
    ready: 'ready', empty: 'No completed videos yet.', emptyHint: 'Render clips in Auto Clipper and they will appear here.',
    upload: 'Send to TikTok', preparing: 'Preparing...', connectFirst: 'Connect your TikTok account before uploading.',
    inboxNote: 'The video is sent as a draft. Open the TikTok inbox notification to add a caption and publish it.',
    completed: 'TikTok accepted the upload', failed: 'Upload failed', defaultError: 'Something went wrong. Please try again.',
  };

  const refreshStatus = useCallback(async () => {
    try {
      const response = await resilientFetch('/api/tiktok/status', { maxRetries: 0, silent: true });
      const data = await response.json() as ConnectionStatus;
      if (!response.ok) throw new Error((data as any)?.detail || words.defaultError);
      setConnection(data);
      if (data.connected) setConnecting(false);
    } catch (err: any) {
      setError(err?.message || words.defaultError);
    } finally { setChecking(false); }
  }, [words.defaultError]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  useEffect(() => {
    if (!connecting) return;
    const interval = window.setInterval(refreshStatus, 1800);
    const timeout = window.setTimeout(() => setConnecting(false), 180000);
    return () => { window.clearInterval(interval); window.clearTimeout(timeout); };
  }, [connecting, refreshStatus]);

  const busy = job?.status === 'queued' || job?.status === 'uploading' || job?.status === 'processing';
  useEffect(() => {
    if (!job?.upload_id || !busy) return;
    let active = true;
    const poll = async () => {
      try {
        const response = await resilientFetch('/api/tiktok/upload/' + job.upload_id, { maxRetries: 0, silent: true });
        if (response.ok) {
          const data = await response.json() as UploadJob;
          if (active) setJob(data);
        }
      } catch { /* Temporary polling errors do not interrupt the server-side upload. */ }
    };
    const interval = window.setInterval(poll, 1500);
    poll();
    return () => { active = false; window.clearInterval(interval); };
  }, [job?.upload_id, busy]);

  const connect = async () => {
    setError('');
    const popup = window.open('about:blank', 'cheatclip-tiktok-oauth', 'popup,width=520,height=720');
    if (!popup) {
      setError(isId ? 'Popup diblokir. Izinkan popup untuk aplikasi ini.' : 'Popup blocked. Allow popups for this app and try again.');
      return;
    }
    setConnecting(true);
    try {
      const response = await resilientFetch('/api/tiktok/auth-url', { maxRetries: 0 });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || words.defaultError);
      popup.location.href = data.authorization_url;
    } catch (err: any) {
      popup.close();
      setConnecting(false);
      setError(err?.message || words.defaultError);
    }
  };

  const disconnect = async () => {
    setError('');
    try {
      const response = await resilientFetch('/api/tiktok/disconnect', { method: 'POST', maxRetries: 0 });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || words.defaultError);
      setConnection((current) => current ? { ...current, connected: false } : current);
      setJob(null);
      setActiveClipIndex(null);
    } catch (err: any) { setError(err?.message || words.defaultError); }
  };

  const clips = (batchProgress?.clips || []).filter((clip) => clip.status === 'completed' && clip.download_url);
  const uploadClip = async (clip: NonNullable<BatchRenderProgress['clips']>[number]) => {
    if (!clip.download_url || busy || preparingClip !== null) return;
    setPreparingClip(clip.clip_index);
    setActiveClipIndex(clip.clip_index);
    setJob(null);
    setError('');
    try {
      let fileName = clip.download_url.split('?')[0].split('/').pop() || '';
      if (clip.download_url.startsWith('blob:')) {
        const videoResponse = await fetch(clip.download_url);
        if (!videoResponse.ok) throw new Error('Could not read the rendered video from this browser.');
        const blob = await videoResponse.blob();
        const form = new FormData();
        const safeTitle = (clip.title || 'clip').replace(/[\\/:*?"<>|]/g, '_');
        form.append('file', blob, safeTitle + '.mp4');
        const response = await resilientFetch('/api/tiktok/prepare', { method: 'POST', body: form, maxRetries: 0 });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.detail || words.defaultError);
        fileName = data.filename;
      }
      try { fileName = decodeURIComponent(fileName); } catch { /* Keep original filename. */ }
      if (!fileName || !fileName.toLowerCase().endsWith('.mp4')) throw new Error('The rendered MP4 filename could not be identified.');
      const response = await resilientFetch('/api/tiktok/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fileName }),
        maxRetries: 0,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || words.defaultError);
      setJob({ upload_id: data.upload_id, status: data.status || 'queued', progress_percent: 0, message: 'Queued' });
    } catch (err: any) {
      setError(err?.message || words.defaultError);
      setActiveClipIndex(null);
    } finally { setPreparingClip(null); }
  };

  const cardStyle: React.CSSProperties = { background: 'rgba(17, 21, 34, .88)', border: '1px solid #30384c', borderRadius: 12, padding: 18, color: '#e5e7eb' };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0 28px' }}>
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.08)', color: '#fff' }}><Play size={25} /></div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <h2 style={{ margin: 0, fontSize: 19 }}>TikTok Studio</h2>
          <p style={{ margin: '5px 0 0', color: '#9ca3af', fontSize: 13 }}>{words.subtitle}</p>
        </div>
        {checking ? <span style={{ color: '#9ca3af', fontSize: 13 }}>{words.checking}</span> : connection?.connected ? (
          <>
            <span style={{ color: '#34d399', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}><CheckCircle2 size={16} /> {words.connected}</span>
            <button type="button" onClick={disconnect} style={{ border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', padding: '8px 12px', borderRadius: 8, cursor: 'pointer' }}>{words.disconnect}</button>
          </>
        ) : (
          <button type="button" onClick={connect} disabled={connecting} style={{ border: 0, background: '#111827', color: 'white', padding: '10px 15px', borderRadius: 8, fontWeight: 750, cursor: connecting ? 'wait' : 'pointer', opacity: connecting ? .6 : 1 }}>
            {connecting ? <><LoaderCircle size={14} className="youtube-upload-spin" /> {words.connecting}</> : words.connect}
          </button>
        )}
      </div>

      {connection && !connection.configured && (
        <div role="alert" style={{ ...cardStyle, borderColor: 'rgba(245,158,11,.4)', color: '#fbbf24', fontSize: 13, lineHeight: 1.6 }}>
          <strong>{words.configTitle}</strong>
          <p style={{ margin: '6px 0' }}>{words.configText}</p>
          <div>{words.redirect} <code>{connection.redirect_uri || 'http://localhost:8000/api/tiktok/callback'}</code></div>
        </div>
      )}
      {error && <div role="alert" style={{ ...cardStyle, borderColor: 'rgba(248,113,113,.4)', color: '#fca5a5', fontSize: 13 }}>{error}</div>}

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div><h3 style={{ margin: 0, fontSize: 16 }}>{words.videos}</h3><p style={{ margin: '4px 0 0', color: '#9ca3af', fontSize: 12 }}>{words.videosHint}</p></div>
          <span style={{ color: '#9ca3af', fontSize: 12 }}>{clips.length} {words.ready}</span>
        </div>
        {clips.length === 0 ? (
          <div style={{ padding: '28px 12px', textAlign: 'center', color: '#9ca3af', border: '1px dashed #3b4356', borderRadius: 9 }}>
            <Play size={24} style={{ marginBottom: 8, opacity: .65 }} /><div>{words.empty}</div><div style={{ fontSize: 12, marginTop: 4 }}>{words.emptyHint}</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 9 }}>
            {clips.map((clip) => {
              const current = activeClipIndex === clip.clip_index;
              return (
                <div key={clip.clip_index} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 12, borderRadius: 9, background: '#111522', border: '1px solid #30384c' }}>
                  <div style={{ width: 34, height: 34, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: 8, background: 'rgba(16,185,129,.12)', color: '#34d399' }}><CheckCircle2 size={18} /></div>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{clip.title || 'Rendered clip'}</div>
                    <div style={{ color: '#9ca3af', fontSize: 11 }}>MP4 · Render complete</div>
                    {current && job && <div style={{ marginTop: 7, fontSize: 11, color: job.status === 'failed' ? '#fca5a5' : '#a5b4fc' }}>{job.status === 'completed' ? words.completed : job.status === 'failed' ? words.failed + ': ' + (job.error || '') : job.message || 'Uploading...'}</div>}
                  </div>
                  {current && busy ? (
                    <div style={{ minWidth: 130, color: '#cbd5e1', fontSize: 12 }}>
                      <div style={{ marginBottom: 5 }}>{job?.progress_percent || 0}%</div>
                      <div style={{ height: 5, background: '#30384c', borderRadius: 99, overflow: 'hidden' }}><div style={{ width: (job?.progress_percent || 0) + '%', height: '100%', background: '#a5b4fc', transition: 'width .2s ease' }} /></div>
                    </div>
                  ) : (
                    <button type="button" disabled={!connection?.connected || busy || preparingClip !== null} onClick={() => uploadClip(clip)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: 0, borderRadius: 8, background: '#111827', color: '#fff', padding: '8px 12px', fontWeight: 700, cursor: 'pointer', opacity: !connection?.connected || busy || preparingClip !== null ? .45 : 1 }}>
                      {preparingClip === clip.clip_index ? <LoaderCircle size={14} className="youtube-upload-spin" /> : <Upload size={14} />}
                      {preparingClip === clip.clip_index ? words.preparing : words.upload}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!connection?.connected && <p style={{ margin: '12px 0 0', color: '#fbbf24', fontSize: 12 }}>{words.connectFirst}</p>}
        <p style={{ margin: '12px 0 0', color: '#94a3b8', fontSize: 12, lineHeight: 1.55 }}>{words.inboxNote}</p>
      </div>
    </section>
  );
};
