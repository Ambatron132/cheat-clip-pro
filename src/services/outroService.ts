export type OutroProgressHandler = (percent: number, stage: string) => void;

/**
 * Sends the rendered clip and the selected outro to the local FFmpeg backend.
 * The backend combines them into one MP4 using the detected hardware encoder.
 */
export async function appendOutroVideo(
  renderedClip: Blob,
  outroFile: File,
  onProgress?: OutroProgressHandler
): Promise<Blob> {
  const formData = new FormData();
  formData.append('main_clip', renderedClip, 'rendered-clip.mp4');
  formData.append('outro_video', outroFile, outroFile.name || 'outro.mp4');

  onProgress?.(94, 'Uploading rendered clip and outro for final assembly...');

  let response: Response;
  try {
    response = await fetch('/api/append-outro', {
      method: 'POST',
      body: formData
    });
  } catch (error) {
    throw new Error(
      `Could not connect to the local video processor: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.detail || payload?.error || '';
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new Error(detail || `Failed to append outro (HTTP ${response.status}).`);
  }

  const output = await response.blob();
  if (!output.size || (output.type && !output.type.includes('video'))) {
    throw new Error('The video processor returned an empty or invalid MP4 file.');
  }

  onProgress?.(99, 'Finalizing video with outro...');
  return new Blob([output], { type: 'video/mp4' });
}
