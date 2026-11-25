import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ffmpegInstance: FFmpeg | null = null;
let isLoaded = false;
let loadPromise: Promise<FFmpeg> | null = null;

export interface ClientRenderOptions {
  videoSourceUrl: string; // URL or Blob URL of the source clip
  startTime?: number;
  endTime?: number;
  aspectRatio: '9:16' | '1:1' | '16:9' | '4:5' | '4:3' | '16:9_landscape';
  backgroundStyle: 'blur' | 'black' | 'fit' | 'crop' | 'blurred';
  titleText?: string;
  titlePosition?: 'top' | 'center' | 'bottom';
  subtitles?: Array<{ start: number; end: number; text: string }>;
  fileName?: string;
  onProgress?: (percent: number, stage: string) => void;
}

/**
 * Initializes and loads FFmpeg WebAssembly instance in browser worker with fallback.
 */
export async function getFFmpeg(onLoadProgress?: (ratio: number) => void): Promise<FFmpeg> {
  if (ffmpegInstance && isLoaded) {
    return ffmpegInstance;
  }

  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();

    ffmpeg.on('log', ({ message }) => {
      console.debug('[FFmpeg-WASM]', message);
    });

    ffmpeg.on('progress', ({ progress }) => {
      const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
      if (onLoadProgress) {
        onLoadProgress(pct);
      }
    });

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    
    try {
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      isLoaded = true;
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    } catch (err) {
      console.warn('Primary ESM FFmpeg WASM load failed, trying standard core fallback...', err);
      const fallbackBase = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${fallbackBase}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${fallbackBase}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      isLoaded = true;
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    }
  })();

  return loadPromise;
}

/**
 * Renders a video clip directly in the client's browser using WebAssembly.
 * Fully offloads CPU computation from the server.
 */
export async function renderClipClientSide(options: ClientRenderOptions): Promise<Blob> {
  const {
    videoSourceUrl,
    startTime = 0,
    endTime,
    aspectRatio = '9:16',
    backgroundStyle = 'blur',
    onProgress
  } = options;

  if (onProgress) onProgress(5, 'Loading Client-Side Engine (WASM)...');
  const ffmpeg = await getFFmpeg((ratio) => {
    if (onProgress) onProgress(Math.min(25, 5 + Math.round(ratio * 0.2)), 'Initializing WASM core...');
  });

  if (onProgress) onProgress(28, 'Fetching video stream to browser memory...');
  const inputData = await fetchFile(videoSourceUrl);
  await ffmpeg.writeFile('input.mp4', inputData);

  // Construct FFmpeg filters based on aspect ratio and background style
  let filterStr = '';
  let targetWidth = 1080;
  let targetHeight = 1920;

  let lastFfmpegLog = '';
  const logHandler = ({ message }: { message: string }) => {
    lastFfmpegLog = message;
    console.debug('[FFmpeg-WASM-Exec]', message);
  };
  ffmpeg.on('log', logHandler);

  if (aspectRatio === '16:9_landscape') {
    targetWidth = 1920;
    targetHeight = 1080;
    filterStr = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black[v]`;
  } else if (aspectRatio === '9:16') {
    targetWidth = 1080;
    targetHeight = 1920;
    if (backgroundStyle === 'blur' || backgroundStyle === 'blurred') {
      filterStr = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},gblur=sigma=12[bg];[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v]`;
    } else if (backgroundStyle === 'black') {
      filterStr = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black[v]`;
    } else {
      // Direct center crop
      filterStr = `[0:v]scale=ih*9/16:ih,scale=${targetWidth}:${targetHeight}[v]`;
    }
  } else if (aspectRatio === '1:1') {
    targetWidth = 1080;
    targetHeight = 1920;
    if (backgroundStyle === 'blur' || backgroundStyle === 'blurred') {
      filterStr = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=12:2[bg];[0:v]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080[fg];[bg][fg]overlay=0:420[v]`;
    } else {
      filterStr = `[0:v]scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080[fg];[fg]pad=1080:1920:0:420:black[v]`;
    }
  } else if (aspectRatio === '4:3') {
    targetWidth = 1080;
    targetHeight = 1920;
    if (backgroundStyle === 'blur' || backgroundStyle === 'blurred') {
      filterStr = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=12:2[bg];[0:v]scale=1080:810:force_original_aspect_ratio=increase,crop=1080:810[fg];[bg][fg]overlay=0:555[v]`;
    } else {
      filterStr = `[0:v]scale=1080:810:force_original_aspect_ratio=increase,crop=1080:810[fg];[fg]pad=1080:1920:0:555:black[v]`;
    }
  } else {
    // 16:9 Letterbox on 1080x1920 vertical canvas
    targetWidth = 1080;
    targetHeight = 1920;
    if (backgroundStyle === 'blur' || backgroundStyle === 'blurred') {
      filterStr = `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},boxblur=12:2[bg];[0:v]scale=1080:608:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=0:656[v]`;
    } else {
      filterStr = `[0:v]scale=1080:608:force_original_aspect_ratio=decrease[fg];[fg]pad=1080:1920:0:656:black[v]`;
    }
  }

  const outputName = 'output.mp4';
  const ffmpegArgs: string[] = ['-i', 'input.mp4'];

  if (startTime > 0) {
    ffmpegArgs.unshift('-ss', startTime.toFixed(2));
  }
  if (endTime && endTime > startTime) {
    ffmpegArgs.push('-t', (endTime - startTime).toFixed(2));
  }

  ffmpegArgs.push(
    '-filter_complex', filterStr,
    '-map', '[v]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-threads', '2',
    '-crf', '26',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    outputName
  );

  ffmpeg.on('progress', ({ progress }) => {
    const pct = Math.min(98, 30 + Math.round(progress * 68));
    if (onProgress) {
      onProgress(pct, `Rendering on your device GPU/CPU (${pct}%)...`);
    }
  });

  if (onProgress) onProgress(35, 'Encoding video on client browser...');
  try {
    const exitCode = await ffmpeg.exec(ffmpegArgs);
    if (exitCode !== 0) {
      throw new Error(`FFmpeg WASM exited with code ${exitCode}. Details: ${lastFfmpegLog || 'Encoding error'}`);
    }
  } catch (err: any) {
    console.error('FFmpeg WASM execution error:', err, 'Last log:', lastFfmpegLog);
    throw new Error(err?.message || lastFfmpegLog || 'Browser WASM engine memory limit exceeded');
  } finally {
    try {
      ffmpeg.off('log', logHandler);
    } catch {
      // Ignore
    }
  }

  if (onProgress) onProgress(99, 'Extracting rendered MP4 file...');
  const outputData = await ffmpeg.readFile(outputName);
  const blob = new Blob([outputData as any], { type: 'video/mp4' });

  // Cleanup virtual files to free WASM memory
  try {
    await ffmpeg.deleteFile('input.mp4');
    await ffmpeg.deleteFile(outputName);
  } catch {
    // Ignore cleanup
  }

  if (onProgress) onProgress(100, 'Rendering Complete!');
  return blob;
}


/**
 * Appends an optional outro video to a rendered clip using a video crossfade.
 * The main clip's audio is retained and faded down at the transition. If the
 * outro contains audio, it is preserved as a second audio stream.
 */
/**
 * Preferred outro path: use the local FastAPI backend's native FFmpeg encoder.
 * This uses NVENC/AMF/QSV where available and avoids the extra software-WASM
 * encode. Fall back to the browser WASM path only if the endpoint is unavailable.
 */
export async function appendOutroVideo(
  mainBlob: Blob,
  outroFile: File,
  fadeDuration = 0.75,
  onProgress?: (percent: number, stage: string) => void
): Promise<Blob> {
  const formData = new FormData();
  formData.append('main_clip', mainBlob, 'rendered-clip.mp4');
  formData.append('outro_video', outroFile, outroFile.name || 'outro.mp4');
  formData.append('fade_duration', String(Math.max(0, Math.min(2, fadeDuration))));

  if (onProgress) onProgress(94, 'Sending videos to the local hardware encoder...');
  let response: Response;
  try {
    response = await fetch('/api/append-outro', {
      method: 'POST',
      body: formData
    });
  } catch (error) {
    console.warn('[Outro] Native FFmpeg endpoint unavailable; falling back to browser WASM.', error);
    if (onProgress) onProgress(95, 'Local encoder unavailable. Falling back to browser rendering...');
    return appendOutroVideoWasm(mainBlob, outroFile, fadeDuration, onProgress);
  }

  if (response.status === 404 || response.status === 503) {
    console.warn(`[Outro] Native FFmpeg endpoint returned ${response.status}; falling back to browser WASM.`);
    if (onProgress) onProgress(95, 'Native encoder unavailable. Falling back to browser rendering...');
    return appendOutroVideoWasm(mainBlob, outroFile, fadeDuration, onProgress);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.detail || payload?.error || '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(detail || `Native FFmpeg outro composition failed (HTTP ${response.status}).`);
  }

  const output = await response.blob();
  if (!output.size || (output.type && !output.type.includes('video'))) {
    throw new Error('The native FFmpeg encoder returned an empty or invalid video file.');
  }
  if (onProgress) onProgress(99, 'Finalizing outro video...');
  return new Blob([output], { type: 'video/mp4' });
}

async function appendOutroVideoWasm(
  mainBlob: Blob,
  outroFile: File,
  fadeDuration = 0.75,
  onProgress?: (percent: number, stage: string) => void
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const mainUrl = URL.createObjectURL(mainBlob);
  const outroUrl = URL.createObjectURL(outroFile);
  const readVideoMetadata = (url: string) => new Promise<{ duration: number; width: number; height: number }>((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const metadata = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      video.src = '';
      resolve(metadata);
    };
    video.onerror = () => reject(new Error('Unable to read the main or outro video metadata.'));
    video.src = url;
  });

  const ffmpegDiagnostics: string[] = [];
  const diagnosticHandler = ({ message }: { message: string }) => {
    ffmpegDiagnostics.push(message);
    if (ffmpegDiagnostics.length > 40) ffmpegDiagnostics.shift();
  };
  ffmpeg.on('log', diagnosticHandler);

  try {
    if (onProgress) onProgress(94, 'Preparing outro video and transition...');
    const [mainMeta, outroMeta] = await Promise.all([readVideoMetadata(mainUrl), readVideoMetadata(outroUrl)]);
    if (!Number.isFinite(mainMeta.duration) || !Number.isFinite(outroMeta.duration) || !mainMeta.width || !mainMeta.height) {
      throw new Error('The uploaded outro video has invalid duration or dimensions.');
    }

    const transitionDuration = Math.max(0, Math.min(fadeDuration, mainMeta.duration, outroMeta.duration));
    const transitionOffset = Math.max(0, mainMeta.duration - transitionDuration);
    const mainInput = 'outro-main-input.mp4';
    const outroInput = 'outro-source-input.mp4';
    const outputName = 'outro-final-output.mp4';
    await ffmpeg.writeFile(mainInput, await fetchFile(mainBlob));
    await ffmpeg.writeFile(outroInput, await fetchFile(outroFile));

    // Inspect stream metadata so audio filters only reference tracks that exist.
    let mainHasAudio = false;
    let outroHasAudio = false;
    const probeLog = ({ message }: { message: string }) => {
      if (/Stream #0:\d+.*Audio:/i.test(message)) mainHasAudio = true;
      if (/Stream #1:\d+.*Audio:/i.test(message)) outroHasAudio = true;
    };
    ffmpeg.on('log', probeLog);
    try {
      await ffmpeg.exec(['-i', mainInput, '-i', outroInput, '-map', '0:v:0', '-t', '0.01', '-f', 'null', '-']);
    } catch {
      // FFmpeg may return a non-zero code for the metadata-only probe; its log is still useful.
    } finally {
      try { ffmpeg.off('log', probeLog); } catch { /* Ignore */ }
    }

    const width = mainMeta.width % 2 === 0 ? mainMeta.width : mainMeta.width - 1;
    const height = mainMeta.height % 2 === 0 ? mainMeta.height : mainMeta.height - 1;
    const videoFilter = transitionDuration > 0
      ? `[0:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v0];[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v1];[v0][v1]xfade=transition=fade:duration=${transitionDuration.toFixed(3)}:offset=${transitionOffset.toFixed(3)},format=yuv420p[v]`
      : `[0:v]fps=30,settb=AVTB,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v0];[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v1];[v0][v1]concat=n=2:v=1:a=0,format=yuv420p[v]`;

    let filterComplex = videoFilter;
    if (mainHasAudio && outroHasAudio) {
      const audioFilter = transitionDuration > 0
        ? `[0:a:0]aresample=48000,asetpts=PTS-STARTPTS,afade=t=out:st=${transitionOffset.toFixed(3)}:d=${transitionDuration.toFixed(3)}[a0];[1:a:0]aresample=48000,asetpts=PTS-STARTPTS,adelay=${Math.round(transitionOffset * 1000)}|${Math.round(transitionOffset * 1000)},afade=t=in:st=${transitionOffset.toFixed(3)}:d=${transitionDuration.toFixed(3)}[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]`
        : '[0:a:0][1:a:0]concat=n=2:v=0:a=1[a]';
      filterComplex += `; ${audioFilter}`;
    } else if (mainHasAudio) {
      const padDuration = Math.max(0, outroMeta.duration - transitionDuration);
      const audioFilter = transitionDuration > 0
        ? `[0:a:0]aresample=48000,asetpts=PTS-STARTPTS,afade=t=out:st=${transitionOffset.toFixed(3)}:d=${transitionDuration.toFixed(3)},apad=pad_dur=${padDuration.toFixed(3)}[a]`
        : `[0:a:0]aresample=48000,asetpts=PTS-STARTPTS,apad=pad_dur=${outroMeta.duration.toFixed(3)}[a]`;
      filterComplex += `; ${audioFilter}`;
    } else if (outroHasAudio) {
      const delayMs = Math.round(transitionOffset * 1000);
      const audioFilter = transitionDuration > 0
        ? `[1:a:0]aresample=48000,asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs},afade=t=in:st=${transitionOffset.toFixed(3)}:d=${transitionDuration.toFixed(3)}[a]`
        : `[1:a:0]aresample=48000,asetpts=PTS-STARTPTS,adelay=${Math.round(mainMeta.duration * 1000)}|${Math.round(mainMeta.duration * 1000)}[a]`;
      filterComplex += `; ${audioFilter}`;
    }

    const args = [
      '-y',
      '-i', mainInput,
      '-i', outroInput,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      ...(mainHasAudio || outroHasAudio ? ['-map', '[a]'] : []),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-movflags', '+faststart',
      outputName
    ];
    if (onProgress) onProgress(96, 'Rendering outro crossfade...');
    let exitCode: number;
    try {
      exitCode = await ffmpeg.exec(args);
    } catch (error) {
      const details = ffmpegDiagnostics.slice(-18).join(' | ');
      throw new Error(`FFmpeg outro processing failed: ${error instanceof Error ? error.message : String(error)}. FFmpeg log: ${details || 'No FFmpeg diagnostic output.'}`);
    }
    if (exitCode !== 0) {
      const details = ffmpegDiagnostics.slice(-18).join(' | ');
      throw new Error(`FFmpeg outro processing exited with code ${exitCode}. FFmpeg log: ${details || 'No FFmpeg diagnostic output.'}`);
    }
    const output = await ffmpeg.readFile(outputName);
    return new Blob([output as any], { type: 'video/mp4' });
  } finally {
    try { ffmpeg.off('log', diagnosticHandler); } catch { /* Ignore listener cleanup errors. */ }
    URL.revokeObjectURL(mainUrl);
    URL.revokeObjectURL(outroUrl);
    for (const name of ['outro-main-input.mp4', 'outro-source-input.mp4', 'outro-final-output.mp4']) {
      try { await ffmpeg.deleteFile(name); } catch { /* Ignore cleanup errors. */ }
    }
  }
}

/**
 * Helper to trigger automatic download of a Blob file in the user's browser.
 */
export function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.mp4') ? filename : `${filename}.mp4`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
