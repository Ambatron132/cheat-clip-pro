import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, LoaderCircle, Play } from 'lucide-react';
import type { BatchRenderProgress } from '../types';
import { resilientFetch } from '../utils/api';
import YouTubeUploadModal from './YouTubeUploadModal';

interface YouTubeSectionProps {
  batchProgress: BatchRenderProgress | null;
}
interface ConnectionStatus {
  configured: boolean;
  connected: boolean;
  redirect_uri?: string;
}

export const YouTubeSection: React.FC<YouTubeSectionProps> = ({ batchProgress }) => {
  const [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<{ fileName: string; title: string; description: string } | null>(null);
  const [preparing, setPreparing] = useState<number | null>(null);
  const isId = document.documentElement.lang === 'id';

  const refreshStatus = useCallback(async () => {
    try {
      const response = await resilientFetch('/api/youtube/status', { maxRetries: 0, silent: true });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || 'Could not check YouTube connection.');
      setConnection(data);
      // Stop background status polling as soon as OAuth has completed.
      if (data.connected) setConnecting(false);
    } catch (err: any) {
      setError(err?.message || 'Could not check YouTube connection.');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  useEffect(() => {
    if (!connecting) return;
    const timer = window.setInterval(refreshStatus, 1800);
    const timeout = window.setTimeout(() => setConnecting(false), 180000);
    return () => { window.clearInterval(timer); window.clearTimeout(timeout); };
  }, [connecting, refreshStatus]);

  const connect = async () => {
    setError('');
    const popup = window.open('about:blank', 'cheatclip-youtube-oauth', 'popup,width=520,height=720');
    if (!popup) {
      setError(isId ? 'Popup diblokir. Izinkan popup untuk aplikasi ini.' : 'Popup blocked. Allow popups for this app and try again.');
      return;
    }
    setConnecting(true);
    try {
      const response = await resilientFetch('/api/youtube/auth-url', { maxRetries: 0 });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || 'Could not start Google authorization.');
      popup.location.href = data.authorization_url;
    } catch (err: any) {
      popup.close();
      setConnecting(false);
      setError(err?.message || 'Could not connect YouTube.');
    }
  };

  const disconnect = async () => {
    setError('');
    try {
      const response = await resilientFetch('/api/youtube/disconnect', { method: 'POST', maxRetries: 0 });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.detail || 'Could not disconnect YouTube.');
      await refreshStatus();
    } catch (err: any) { setError(err?.message || 'Could not disconnect YouTube.'); }
  };

  const completed = (batchProgress?.clips || []).filter(clip => clip.status === 'completed' && clip.download_url);

  const prepareUpload = async (clip: NonNullable<BatchRenderProgress['clips']>[number]) => {
    if (!clip.download_url || preparing !== null) return;
    setPreparing(clip.clip_index);
    setError('');
    try {
      let fileName = clip.download_url.split('?')[0].split('/').pop() || '';
      if (clip.download_url.startsWith('blob:')) {
        const videoResponse = await fetch(clip.download_url);
        if (!videoResponse.ok) throw new Error('Could not read the rendered video from this browser.');
        const blob = await videoResponse.blob();
        const form = new FormData();
        form.append('file', blob, (clip.title || 'clip').replace(/[\\\\/:*?"<>|]/g, '_') + '.mp4');
        const response = await resilientFetch('/api/youtube/prepare', { method: 'POST', body: form, maxRetries: 0 });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.detail || 'Could not prepare the video for upload.');
        fileName = data.filename;
      }
      if (!fileName || !fileName.toLowerCase().endsWith('.mp4')) throw new Error('The rendered MP4 filename could not be identified.');
      setSelected({ fileName, title: clip.title || 'Cheat Clip video', description: clip.description || '' });
    } catch (err: any) { setError(err?.message || 'Could not prepare the video for upload.'); }
    finally { setPreparing(null); }
  };

  const cardStyle: React.CSSProperties = { background: 'rgba(17, 21, 34, .88)', border: '1px solid #30384c', borderRadius: 12, padding: 18, color: '#e5e7eb' };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0 28px' }}>
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'rgba(239,68,68,.14)', color: '#f87171' }}>
          <Play size={26} />
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <h2 style={{ margin: 0, fontSize: 19 }}>YouTube Studio</h2>
          <p style={{ margin: '5px 0 0', color: '#9ca3af', fontSize: 13 }}>Connect your channel, then publish videos rendered in Auto Clipper.</p>
        </div>
        {checking ? <span style={{ color: '#9ca3af', fontSize: 13 }}>Checking connection…</span> : connection?.connected ? (
          <>
            <span style={{ color: '#34d399', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}><CheckCircle2 size={16}/> Connected</span>
            <button type="button" onClick={disconnect} style={{ border: '1px solid #475569', background: 'transparent', color: '#cbd5e1', padding: '8px 12px', borderRadius: 8, cursor: 'pointer' }}>Disconnect</button>
          </>
        ) : (
          <button type="button" onClick={connect} disabled={connecting} style={{ border: 0, background: '#dc2626', color: 'white', padding: '10px 15px', borderRadius: 8, fontWeight: 750, cursor: connecting ? 'wait' : 'pointer', opacity: connecting ? .6 : 1 }}>
            {connecting ? <><LoaderCircle size={14} className="youtube-upload-spin" /> Connecting…</> : 'Connect YouTube'}
          </button>
        )}
      </div>

      {connection && !connection.configured && (
        <div role="alert" style={{ ...cardStyle, borderColor: 'rgba(245,158,11,.4)', color: '#fbbf24', fontSize: 13, lineHeight: 1.6 }}>
          YouTube OAuth is not configured yet. Add YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET to backend/.env and enable YouTube Data API v3 in Google Cloud. Redirect URI: <code>{connection.redirect_uri || 'http://localhost:8000/api/youtube/callback'}</code>
        </div>
      )}
      {error && <div role="alert" style={{ ...cardStyle, borderColor: 'rgba(248,113,113,.4)', color: '#fca5a5', fontSize: 13 }}>{error}</div>}

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Rendered videos</h3>
            <p style={{ margin: '4px 0 0', color: '#9ca3af', fontSize: 12 }}>Completed videos from your latest Auto Clipper render batch.</p>
          </div>
          <span style={{ color: '#9ca3af', fontSize: 12 }}>{completed.length} ready</span>
        </div>
        {completed.length === 0 ? (
          <div style={{ padding: '28px 12px', textAlign: 'center', color: '#9ca3af', border: '1px dashed #3b4356', borderRadius: 9 }}>
            <Play size={24} style={{ marginBottom: 8, opacity: .65 }} />
            <div>No completed videos yet.</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Render clips in Auto Clipper and they will appear here.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 9 }}>
            {completed.map(clip => (
              <div key={clip.clip_index} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: 12, borderRadius: 9, background: '#111522', border: '1px solid #30384c' }}>
                <div style={{ width: 34, height: 34, flex: '0 0 auto', display: 'grid', placeItems: 'center', borderRadius: 8, background: 'rgba(16,185,129,.12)', color: '#34d399' }}><CheckCircle2 size={18}/></div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{clip.title || 'Rendered clip'}</div>
                  <div style={{ color: '#9ca3af', fontSize: 11 }}>MP4 · Render complete</div>
                </div>
                <button type="button" disabled={preparing !== null} onClick={() => prepareUpload(clip)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: 0, borderRadius: 8, background: '#dc2626', color: '#fff', padding: '8px 12px', fontWeight: 700, cursor: preparing !== null ? 'wait' : 'pointer', opacity: preparing !== null ? .45 : 1 }}>
                  {preparing === clip.clip_index ? <LoaderCircle size={14} className="youtube-upload-spin"/> : <ExternalLink size={14}/>}
                  Upload to YouTube
                </button>
              </div>
            ))}
          </div>
        )}
        <p style={{ margin: '12px 0 0', color: '#94a3b8', fontSize: 12 }}>Choose YouTube API or Browser Upload (Playwright) in the next window. Browser Upload does not require Google API credentials.</p>
      </div>
      {selected && <YouTubeUploadModal fileName={selected.fileName} initialTitle={selected.title} initialDescription={selected.description} onClose={() => setSelected(null)} />}
    </section>
  );
};
