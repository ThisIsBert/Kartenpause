// Loaded only on explicit developer request; no normal UI or retained canvases.
export function showWandDebug(debug) {
  if (!debug) throw new Error('Zuerst Debugging aktivieren und intelligent auswählen.');
  document.getElementById('wandDebugDialog')?.remove();
  const dialog = document.createElement('dialog'); dialog.id = 'wandDebugDialog';
  dialog.style.cssText = 'max-width:95vw;max-height:90vh;overflow:auto;background:#fff;color:#222;padding:20px;border:1px solid #777';
  const close = document.createElement('button'); close.textContent = 'Debugansichten schließen'; close.onclick = () => dialog.close(); dialog.append(close);
  const grid = document.createElement('div'); grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(180px,1fr));gap:12px'; dialog.append(grid);
  for (const [title, kind] of [['1 · Vereinfachtes Bild', 'simplified'], ['2 · Region vor Randkorrektur', 'coarse'], ['3 · Randkorridor (orange)', 'corridor'], ['4 · Endgültige Maske', 'final']]) {
    const figure = document.createElement('figure'); figure.style.margin = '8px 0';
    const caption = document.createElement('figcaption'); caption.textContent = title;
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:100%;height:auto;image-rendering:pixelated;border:1px solid #ccc';
    const source = kind === 'simplified' ? debug.simplified : debug;
    const scale = Math.max(1, source.width / 800, source.height / 600);
    canvas.width = Math.ceil(source.width / scale); canvas.height = Math.ceil(source.height / scale);
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = Math.min(source.height - 1, Math.floor(y * scale)) * source.width + Math.min(source.width - 1, Math.floor(x * scale));
      const color = kind === 'simplified' ? source.data.subarray(i * 4, i * 4 + 4)
        : kind === 'corridor' && debug.corridor[i] !== 255 ? [226, 144, 35, 255]
          : debug[kind === 'corridor' ? 'coarse' : kind][i] ? [24, 142, 172, 255] : [248, 248, 248, 255];
      image.data.set(color, (y * canvas.width + x) * 4);
    }
    ctx.putImageData(image, 0, 0); figure.append(caption, canvas); grid.append(figure);
  }
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal(); return dialog;
}
