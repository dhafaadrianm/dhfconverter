import { deflate, inflate } from 'pako';

export interface DHFMeta {
  w: number;
  h: number;
  format?: string;
  createdAt?: string;
  name?: string;
  [key: string]: unknown;
}

export interface EncodeResult {
  dhfBytes: Uint8Array;
  blob: Blob;
  meta: DHFMeta;
  rawSize: number;
  compressedSize: number;
  ratio: number;
  durationMs: number;
  filename: string;
}

export interface DecodeResult {
  canvas: HTMLCanvasElement;
  dataUrl: string;
  meta: DHFMeta;
  fileBytes: number;
  pixelBytes: number;
  metaLen: number;
  durationMs: number;
}

export class MagicBytesError extends Error {
  public detectedType?: 'JPEG' | 'PNG' | 'GIF' | 'WEBP' | 'BMP' | 'UNKNOWN';
  public magicFound: string;
  public rawFile?: File;

  constructor(
    message: string,
    magicFound: string,
    detectedType?: 'JPEG' | 'PNG' | 'GIF' | 'WEBP' | 'BMP' | 'UNKNOWN',
    rawFile?: File
  ) {
    super(message);
    this.name = 'MagicBytesError';
    this.magicFound = magicFound;
    this.detectedType = detectedType;
    this.rawFile = rawFile;
  }
}

/**
 * Checks for known image signatures to detect manual file rename attempts
 */
export function detectRawImageType(bytes: Uint8Array): 'JPEG' | 'PNG' | 'GIF' | 'WEBP' | 'BMP' | 'UNKNOWN' {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'JPEG';
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'PNG';
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'GIF';
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'WEBP';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'BMP';
  }
  return 'UNKNOWN';
}

/**
 * Encodes an HTMLImageElement or Canvas into the custom .DHF binary format
 */
export async function encodeToDHF(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  filename = 'citra.dhf',
  extraMeta?: Record<string, unknown>
): Promise<EncodeResult> {
  const startTime = performance.now();

  const width = 'naturalWidth' in source ? source.naturalWidth || source.width : source.width;
  const height = 'naturalHeight' in source ? source.naturalHeight || source.height : source.height;

  if (width <= 0 || height <= 0) {
    throw new Error('Dimensi gambar tidak valid (lebar atau tinggi 0).');
  }

  // Canvas to extract RGBA raw pixel data
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Gagal menginisialisasi context canvas 2D.');

  ctx.drawImage(source, 0, 0);
  const imgData = ctx.getImageData(0, 0, width, height).data;

  // Metadata JSON
  const metaObj: DHFMeta = {
    w: width,
    h: height,
    format: 'DHF-1.0',
    createdAt: new Date().toISOString(),
    ...extraMeta,
  };

  const metadataStr = JSON.stringify(metaObj);
  const encoder = new TextEncoder();
  const metadataBytes = encoder.encode(metadataStr);
  const header = encoder.encode('DHF!'); // 4 bytes ASCII signature

  // metaLen as 4-byte uint32 (little endian)
  const metaLenBuffer = new ArrayBuffer(4);
  const metaLenView = new DataView(metaLenBuffer);
  metaLenView.setUint32(0, metadataBytes.length, true);
  const metaLenBytes = new Uint8Array(metaLenBuffer);

  // Raw payload = metadata bytes + raw RGBA pixel data
  const rawPayload = new Uint8Array(metadataBytes.length + imgData.length);
  rawPayload.set(metadataBytes, 0);
  rawPayload.set(imgData, metadataBytes.length);

  // Compress using pako (deflate zlib)
  const compressedPayload = deflate(rawPayload, { level: 6 });

  // Final DHF binary = [4 bytes Header "DHF!"] + [4 bytes metaLen] + [Compressed Payload]
  const fileDHF = new Uint8Array(header.length + metaLenBytes.length + compressedPayload.length);
  fileDHF.set(header, 0);
  fileDHF.set(metaLenBytes, header.length);
  fileDHF.set(compressedPayload, header.length + metaLenBytes.length);

  const durationMs = Math.round(performance.now() - startTime);
  const blob = new Blob([fileDHF], { type: 'application/octet-stream' });
  const rawSize = rawPayload.length;
  const compressedSize = fileDHF.length;
  const ratio = Number(((1 - compressedSize / rawSize) * 100).toFixed(1));

  return {
    dhfBytes: fileDHF,
    blob,
    meta: metaObj,
    rawSize,
    compressedSize,
    ratio,
    durationMs,
    filename: filename.endsWith('.dhf') ? filename : `${filename}.dhf`,
  };
}

/**
 * Decodes .DHF binary ArrayBuffer back into canvas and image data URL
 */
export async function decodeDHF(
  input: ArrayBuffer | ArrayBufferView | SharedArrayBuffer,
  fileRef?: File
): Promise<DecodeResult> {
  const startTime = performance.now();
  const bytes =
    input instanceof Uint8Array
      ? input
      : ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input as ArrayBuffer);

  if (bytes.length < 8) {
    throw new Error('Ukuran file terlalu kecil atau rusak (kurang dari 8 byte header).');
  }

  // 1. Check Magic Signature "DHF!" (4 bytes)
  const decoder = new TextDecoder();
  const magic = decoder.decode(bytes.subarray(0, 4));

  if (magic !== 'DHF!') {
    const rawType = detectRawImageType(bytes);
    let msg = `Gagal membaca format: Magic Bytes salah (ditemukan "${magic.replace(/[\x00-\x1F\x7F-\x9F]/g, '?')}").`;
    if (rawType !== 'UNKNOWN') {
      msg = `Berkas ini terdeteksi sebagai format asli ${rawType} yang diubah namanya (rename) menjadi .dhf. Format .DHF memerlukan kompresi biner khusus dengan signature "DHF!".`;
    }
    throw new MagicBytesError(msg, magic, rawType, fileRef);
  }

  // 2. Read meta length (4 bytes uint32, little endian)
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = dataView.getUint32(4, true);

  if (metaLen <= 0 || metaLen > bytes.length * 10) {
    throw new Error('Struktur header metadata rusak atau panjang tidak valid.');
  }

  // 3. Decompress payload using pako.inflate
  const compressedPayload = bytes.subarray(8);
  let decompressed: Uint8Array;
  try {
    decompressed = inflate(compressedPayload);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gagal mendekompresi payload zlib: ${message}`);
  }

  if (decompressed.length < metaLen) {
    throw new Error('Data terdekompresi tidak memuat metadata yang cukup.');
  }

  // 4. Parse Metadata
  const metadataStr = decoder.decode(decompressed.subarray(0, metaLen));
  let meta: DHFMeta;
  try {
    meta = JSON.parse(metadataStr);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gagal membaca metadata JSON: ${message}`);
  }

  if (!meta.w || !meta.h || meta.w <= 0 || meta.h <= 0) {
    throw new Error(`Dimensi citra tidak valid: ${meta.w}x${meta.h}`);
  }

  // 5. Extract raw RGBA pixel data
  const pixelData = decompressed.subarray(metaLen);
  const expectedBytes = meta.w * meta.h * 4;
  if (pixelData.length < expectedBytes) {
    throw new Error(
      `Panjang data piksel (${pixelData.length} B) tidak cocok dengan resolusi ${meta.w}x${meta.h} (harus ${expectedBytes} B).`
    );
  }

  // 6. Draw to Canvas
  const canvas = document.createElement('canvas');
  canvas.width = meta.w;
  canvas.height = meta.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Gagal menginisialisasi context canvas.');

  const imgData = ctx.createImageData(meta.w, meta.h);
  imgData.data.set(pixelData.subarray(0, expectedBytes));
  ctx.putImageData(imgData, 0, 0);

  const dataUrl = canvas.toDataURL('image/png');
  const durationMs = Math.round(performance.now() - startTime);

  return {
    canvas,
    dataUrl,
    meta,
    fileBytes: bytes.length,
    pixelBytes: expectedBytes,
    metaLen,
    durationMs,
  };
}

/**
 * Creates a synthetic demo .dhf file
 */
export async function createDemoDHF(name = 'Apple_Minimal_Demo.dhf'): Promise<EncodeResult> {
  const width = 800;
  const height = 600;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#0f172a');
  bgGrad.addColorStop(0.5, '#1e293b');
  bgGrad.addColorStop(1, '#020617');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  const drawGlow = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  drawGlow(280, 240, 220, 'rgba(37, 99, 235, 0.45)');
  drawGlow(520, 360, 260, 'rgba(99, 102, 241, 0.35)');
  drawGlow(400, 480, 180, 'rgba(14, 165, 233, 0.3)');

  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(160, 140, 480, 320, 24);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = '600 36px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('DHF Converter', width / 2, 260);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = '400 16px Inter, system-ui, sans-serif';
  ctx.fillText('Format Citra Kompresi ZLIB Lossless RGBA', width / 2, 300);

  ctx.fillStyle = 'rgba(37, 99, 235, 0.25)';
  ctx.strokeStyle = 'rgba(37, 99, 235, 0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(width / 2 - 90, 340, 180, 36, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#60a5fa';
  ctx.font = '500 14px "JetBrains Mono", monospace';
  ctx.fillText('MAGIC: DHF!', width / 2, 363);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.font = '400 13px "JetBrains Mono", monospace';
  ctx.fillText('PT DHAFA TETAP BERUSAHA', width / 2, 420);

  return encodeToDHF(canvas, name, {
    description: 'Sample image generated natively by DHF Converter',
    company: 'PT DHAFA TETAP BERUSAHA',
  });
}

/**
 * Generates the clean standalone index.html string for Netlify and GitHub
 */
export function generateStandaloneHtml(): string {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DHF Converter</title>
  <meta name="description" content="Ubah gambar standar (JPG/PNG) menjadi format eksklusif .DHF dan sebaliknya secara instan dari peramban web. Dikembangkan oleh PT DHAFA TETAP BERUSAHA.">

  <!-- Google Fonts: Inter & JetBrains Mono -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">

  <!-- Tailwind CSS via CDN -->
  <script src="https://cdn.tailwindcss.com"></script>

  <!-- Pako (ZLIB Deflate/Inflate) -->
  <script src="https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js"></script>

  <script>
    tailwind.config = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
            mono: ['JetBrains Mono', 'ui-monospace', 'monospace']
          },
          colors: {
            appleBg: '#f5f5f7',
            appleBlue: '#2563eb',
            appleText: '#1d1d1f'
          }
        }
      }
    }
  </script>
  <style>
    body {
      background-color: #f5f5f7;
      color: #1d1d1f;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased;
    }
    .dropzone-active {
      border-color: #2563eb !important;
      background-color: rgba(37, 99, 235, 0.06) !important;
      transform: scale(1.005);
    }
  </style>
</head>
<body class="bg-[#f5f5f7] text-[#1d1d1f] min-h-screen flex flex-col justify-between p-4 md:p-8 selection:bg-blue-600 selection:text-white">

  <!-- Top Navigation -->
  <nav class="w-full max-w-5xl mx-auto flex justify-between items-center border-b border-gray-200 pb-4 mb-10">
    <span class="text-xl font-extrabold tracking-tight">DHF <span class="text-blue-600">Converter</span></span>
    <span class="text-xs font-semibold text-gray-500 bg-white border border-gray-200 px-3 py-1 rounded-full shadow-xs">v1.3.0</span>
  </nav>

  <!-- Hairline Loading Bar -->
  <div id="loading-bar" class="hidden fixed top-0 left-0 right-0 h-0.5 bg-blue-600 z-50 animate-pulse"></div>

  <!-- Main Container -->
  <main class="w-full max-w-5xl mx-auto my-auto py-6 grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
    
    <!-- Left Side: Title & Description -->
    <div class="space-y-4 pr-0 md:pr-6">
      <div class="inline-flex items-center bg-blue-50 border border-blue-200 text-blue-600 text-[11px] px-3 py-0.5 rounded-full font-bold uppercase tracking-wider">
        Next-Gen Custom Format
      </div>
      <h1 class="text-3xl md:text-4xl font-extrabold tracking-tight leading-tight text-gray-900">
        DHF Converter
      </h1>
      <p class="text-gray-500 text-sm md:text-base leading-relaxed">
        DHF adalah format yang memungkinkan anda menjaga privasi foto anda.
      </p>
    </div>

    <!-- Right Side: Interface Cards -->
    <div class="space-y-6">
      
      <!-- KOTAK ENCODER: JPG/PNG ke .DHF -->
      <div class="bg-white border border-gray-200 rounded-2xl p-6 shadow-xs transition-all duration-300 hover:shadow-md space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-bold text-gray-800">Ubah JPG / PNG ke .DHF</h2>
          <span class="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md border border-gray-100 font-medium">Encoder</span>
        </div>
        
        <label id="dropzone-biasa" for="upload-biasa" class="flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100/70 border border-gray-200 border-dashed rounded-xl py-8 px-4 cursor-pointer transition-all duration-200 group">
          <div class="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-500 group-hover:bg-blue-50 group-hover:text-blue-600 mb-2 transition-colors">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          </div>
          <span class="text-xs font-semibold text-gray-600 group-hover:text-blue-600 transition-colors">Pilih atau Seret Foto Anda</span>
          <span class="text-[10px] text-gray-400 mt-1">Mendukung file PNG atau JPG</span>
          <input type="file" id="upload-biasa" accept="image/png,image/jpeg,image/webp,image/bmp" class="hidden">
        </label>

        <!-- Encoder Status & Action -->
        <div id="action-encoder" class="hidden space-y-3 pt-1">
          <div class="flex items-center justify-between text-xs bg-gray-50 p-3 rounded-xl border border-gray-100">
            <span id="enc-filename" class="font-medium text-gray-700 truncate max-w-[180px]">citra.jpg</span>
            <span id="enc-ratio" class="font-mono text-emerald-600 font-semibold">-</span>
          </div>
          <button id="btn-convert-dhf" class="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white font-semibold py-2.5 px-4 rounded-xl text-xs transition-colors shadow-xs cursor-pointer flex items-center justify-center gap-1.5">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
            <span>Unduh Berkas .DHF</span>
          </button>
        </div>
      </div>

      <!-- KOTAK DECODER: .DHF ke Foto Asli -->
      <div class="bg-white border border-gray-200 rounded-2xl p-6 shadow-xs transition-all duration-300 hover:shadow-md space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-bold text-gray-800">Buka File .DHF ke Gambar Asli</h2>
          <span class="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md border border-gray-100 font-medium">Decoder</span>
        </div>

        <label id="dropzone-dhf" for="upload-dhf" class="flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100/70 border border-gray-200 border-dashed rounded-xl py-8 px-4 cursor-pointer transition-all duration-200 group">
          <div class="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-500 group-hover:bg-blue-50 group-hover:text-blue-600 mb-2 transition-colors">
            <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
          </div>
          <span class="text-xs font-semibold text-gray-600 group-hover:text-blue-600 transition-colors">Pilih Berkas .DHF</span>
          <span class="text-[10px] text-gray-400 mt-1">Hanya memproses format khusus .dhf</span>
          <input type="file" id="upload-dhf" accept=".dhf" class="hidden">
        </label>

        <!-- Preview Area -->
        <div id="preview-container" class="mt-4 hidden border border-gray-100 bg-gray-50 rounded-xl p-3 flex flex-col items-center">
          <div class="flex items-center justify-between w-full mb-2">
            <span class="text-[10px] text-blue-600 font-bold uppercase tracking-wider">Hasil Pratinjau Foto:</span>
            <span id="preview-meta" class="text-[11px] font-mono text-gray-500 tabular-nums">-</span>
          </div>
          <img id="hasil-foto" class="w-full h-auto rounded-lg max-h-40 object-contain mb-4 bg-white border border-gray-200" alt="Hasil Foto DHF">
          
          <!-- AREA BUTTON PILIHAN UNDUHAN: PNG, JPG, WEBP -->
          <div id="download-options" class="w-full grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button id="btn-dl-png" class="bg-gray-900 hover:bg-black text-white text-xs font-semibold py-2 px-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              <span>Unduh sebagai PNG</span>
            </button>
            <button id="btn-dl-jpg" class="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2 px-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              <span>Unduh sebagai JPG</span>
            </button>
            <button id="btn-dl-webp" class="bg-white hover:bg-gray-100 border border-gray-200 text-gray-800 text-xs font-semibold py-2 px-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs">
              <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg>
              <span>Unduh sebagai WEBP</span>
            </button>
          </div>
        </div>
      </div>

    </div>
  </main>

  <!-- Footer -->
  <footer class="w-full max-w-5xl mx-auto border-t border-gray-200 pt-6 mt-12 text-[11px] text-gray-400 flex flex-col md:flex-row justify-between gap-4 items-start md:items-center">
    <div class="max-w-xl">&copy; 2026 dhf adalah format privasi yang dikembangkan oleh DHAFA ADRIAN MAULANA dengan tujuan menjaga privasi foto anda. Hak cipta dilindungi oleh undang - undang</div>
    <div class="font-bold text-gray-500 whitespace-nowrap">Dikembangkan oleh PT DHAFA TETAP BERUSAHA</div>
  </footer>

  <!-- MODAL ERROR POP-UP: MAGIC BYTES MISMATCH / MANUAL RENAME DETECTED -->
  <div id="error-modal" class="hidden fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-gray-100 space-y-4 transform transition-all">
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shrink-0">
          <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
        </div>
        <div class="space-y-1 flex-1">
          <h3 class="text-sm font-bold text-gray-900" id="error-modal-title">Format Tidak Valid: Ganti Nama Manual Terdeteksi</h3>
          <p class="text-xs text-gray-500 leading-relaxed" id="error-modal-message">
            Sistem mendeteksi bahwa berkas ini tampaknya merupakan gambar asli yang hanya diganti namanya (rename) menjadi .dhf. Format .DHF memerlukan kompresi biner khusus dengan Magic Bytes "DHF!".
          </p>
        </div>
      </div>

      <div class="bg-gray-50 rounded-xl p-3 border border-gray-100 text-[11px] text-gray-600 space-y-1">
        <div class="flex justify-between">
          <span class="text-gray-400">Header Ditemukan:</span>
          <span id="error-modal-header" class="font-mono font-semibold text-red-600">-</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">Header Wajib:</span>
          <span class="font-mono font-semibold text-blue-600">DHF! (0x44 0x48 0x46 0x21)</span>
        </div>
      </div>

      <div class="flex gap-2 pt-2">
        <button id="btn-modal-fix" class="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2.5 rounded-xl transition-colors shadow-xs">
          Konversi via Encoder Sekarang
        </button>
        <button id="btn-modal-close" class="px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold py-2.5 rounded-xl transition-colors">
          Tutup
        </button>
      </div>
    </div>
  </div>

  <!-- Toast Notification Container -->
  <div id="toast-container" class="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"></div>

  <!-- JAVASCRIPT ENGINE -->
  <script>
    // Toast Notifikasi
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl text-xs font-medium transition-all duration-300 transform translate-y-4 opacity-0 ' + 
        (type === 'error' ? 'bg-red-600 text-white shadow-red-600/20' : (type === 'success' ? 'bg-gray-900 text-white shadow-gray-900/20' : 'bg-white text-gray-800 border border-gray-200'));
      toast.innerHTML = '<span>' + message + '</span>';
      container.appendChild(toast);
      requestAnimationFrame(() => toast.classList.remove('translate-y-4', 'opacity-0'));
      setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // Modal Eror
    let pendingFileToEncode = null;
    function showErrorModal(title, message, headerHex, rawFile) {
      document.getElementById('error-modal-title').textContent = title;
      document.getElementById('error-modal-message').textContent = message;
      document.getElementById('error-modal-header').textContent = headerHex;
      pendingFileToEncode = rawFile || null;
      document.getElementById('error-modal').classList.remove('hidden');
    }

    document.getElementById('btn-modal-close').addEventListener('click', () => {
      document.getElementById('error-modal').classList.add('hidden');
    });

    document.getElementById('btn-modal-fix').addEventListener('click', () => {
      document.getElementById('error-modal').classList.add('hidden');
      if (pendingFileToEncode) {
        processEncoderFile(pendingFileToEncode);
      }
    });

    // Deteksi Format Berkas Berdasarkan Signature
    function detectRawFileType(bytes) {
      if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'JPEG';
      if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'PNG';
      if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'GIF';
      if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'WEBP';
      return 'UNKNOWN';
    }

    // Format Bita
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Drag and Drop & Visual feedback
    const setupDropzone = (zoneId, inputId, onSelect) => {
      const zone = document.getElementById(zoneId);
      const input = document.getElementById(inputId);
      if(!zone || !input) return;
      ['dragenter', 'dragover'].forEach(name => {
        zone.addEventListener(name, (e) => { e.preventDefault(); zone.classList.add('border-blue-500', 'bg-blue-50/50'); }, false);
      });
      ['dragleave', 'drop'].forEach(name => {
        zone.addEventListener(name, (e) => { e.preventDefault(); zone.classList.remove('border-blue-500', 'bg-blue-50/50'); }, false);
      });
      zone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if(dt.files.length) {
          input.files = dt.files;
          if (onSelect) onSelect(dt.files[0]);
          else input.dispatchEvent(new Event('change'));
        }
      }, false);
      input.addEventListener('change', (e) => {
        if (e.target.files.length) {
          if (onSelect) onSelect(e.target.files[0]);
        }
      });
    };

    // State
    let encodedDHFBlob = null;
    let encodedFilename = 'citra.dhf';
    let decodedDataUrl = null;
    let decodedCanvas = null;

    // Logic Encoder
    function processEncoderFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(event) {
        const img = new Image();
        img.onload = function() {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = img.width; canvas.height = img.height;
          ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, img.width, img.height).data;
          const metadata = JSON.stringify({ w: img.width, h: img.height, name: file.name });
          const encoder = new TextEncoder();
          const metadataBytes = encoder.encode(metadata);
          const header = encoder.encode("DHF!");
          const metaLen = new Uint32Array([metadataBytes.length]);
          const metaLenBytes = new Uint8Array(metaLen.buffer);
          const rawPayload = new Uint8Array(metadataBytes.length + imgData.length);
          rawPayload.set(metadataBytes, 0); rawPayload.set(imgData, metadataBytes.length);
          const compressedPayload = pako.deflate(rawPayload);
          const fileDHF = new Uint8Array(header.length + metaLenBytes.length + compressedPayload.length);
          fileDHF.set(header, 0); fileDHF.set(metaLenBytes, header.length); fileDHF.set(compressedPayload, header.length + metaLenBytes.length);
          
          encodedDHFBlob = new Blob([fileDHF], { type: "application/octet-stream" });
          const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || 'citra';
          encodedFilename = baseName + ".dhf";

          const ratio = ((1 - fileDHF.length / rawPayload.length) * 100).toFixed(1);
          document.getElementById('enc-filename').textContent = file.name;
          document.getElementById('enc-ratio').textContent = ratio + '% Lebih Hemat';
          document.getElementById('action-encoder').classList.remove('hidden');

          showToast('Berkas ' + encodedFilename + ' berhasil dienkode (' + formatBytes(fileDHF.length) + ')', 'success');
        };
        img.onerror = function() {
          showToast('File bukan gambar yang valid.', 'error');
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    }

    document.getElementById('btn-convert-dhf').onclick = () => {
      if (!encodedDHFBlob) return;
      const url = URL.createObjectURL(encodedDHFBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = encodedFilename;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Unduhan berkas ' + encodedFilename + ' dimulai!', 'success');
    };

    // Logic Decoder
    function decodeDHF(arrayBuffer, rawFile) {
      try {
        const bytes = new Uint8Array(arrayBuffer);
        if (bytes.length < 8) {
          throw new Error('Ukuran file terlalu kecil atau bukan berkas .dhf yang sah.');
        }

        const decoder = new TextDecoder();
        const magic = decoder.decode(bytes.subarray(0, 4));

        // PENANGANAN EROR MAGIC BYTES
        if (magic !== "DHF!") {
          const detectedType = detectRawFileType(bytes);
          const hexPreview = Array.from(bytes.subarray(0, 4)).map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
          
          if (detectedType !== 'UNKNOWN') {
            showErrorModal(
              'Format Tidak Valid: Ganti Nama Manual Terdeteksi',
              'Sistem mendeteksi bahwa berkas "' + (rawFile ? rawFile.name : 'ini') + '" sebenarnya merupakan format ' + detectedType + ' asli yang diubah namanya menjadi .dhf. Format .DHF memerlukan kompresi biner khusus.',
              hexPreview + ' (' + detectedType + ')',
              rawFile
            );
          } else {
            showErrorModal(
              'Kegagalan Magic Bytes: Bukan Format .DHF',
              'Header biner berkas tidak memuat penanda wajib "DHF!". Berkas ini mungkin rusak atau bukan dihasilkan oleh DHF Converter.',
              hexPreview,
              rawFile
            );
          }
          return;
        }

        const metaLenBytes = bytes.subarray(4, 8);
        const metaLen = new Uint32Array(metaLenBytes.buffer, metaLenBytes.byteOffset, 1)[0];
        const compressedPayload = bytes.subarray(8);
        const decompressed = pako.inflate(compressedPayload);
        const metadataStr = decoder.decode(decompressed.subarray(0, metaLen));
        const meta = JSON.parse(metadataStr);
        const pixelData = decompressed.subarray(metaLen);

        const canvas = document.createElement('canvas');
        canvas.width = meta.w; canvas.height = meta.h;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(meta.w, meta.h);
        imgData.data.set(pixelData); ctx.putImageData(imgData, 0, 0);

        decodedCanvas = canvas;
        decodedDataUrl = canvas.toDataURL();
        document.getElementById('hasil-foto').src = decodedDataUrl;
        document.getElementById('preview-meta').textContent = meta.w + ' × ' + meta.h + ' px · ' + formatBytes(bytes.length);
        document.getElementById('preview-container').classList.remove('hidden');

        showToast('Citra .DHF berhasil dibuka (' + meta.w + '×' + meta.h + ' px)', 'success');
      } catch (err) {
        showToast('Gagal mendekode: ' + err.message, 'error');
      }
    }

    // Setup Dropzones
    setupDropzone('dropzone-biasa', 'upload-biasa', (file) => processEncoderFile(file));
    setupDropzone('dropzone-dhf', 'upload-dhf', (file) => {
      const reader = new FileReader();
      reader.onload = (e) => decodeDHF(e.target.result, file);
      reader.readAsArrayBuffer(file);
    });

    // Helper Fungsi Unduh Format (PNG, JPG, WEBP)
    function downloadDecodedFormat(format) {
      if (!decodedCanvas) return;
      const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
      const ext = format === 'jpg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
      const quality = format === 'png' ? undefined : 0.92;
      const dataUrl = decodedCanvas.toDataURL(mime, quality);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'hasil_foto_dhf.' + ext;
      a.click();
      showToast('Citra berhasil diunduh sebagai ' + format.toUpperCase() + '!', 'success');
    }

    document.getElementById('btn-dl-png')?.addEventListener('click', () => downloadDecodedFormat('png'));
    document.getElementById('btn-dl-jpg')?.addEventListener('click', () => downloadDecodedFormat('jpg'));
    document.getElementById('btn-dl-webp')?.addEventListener('click', () => downloadDecodedFormat('webp'));

    // URL Parameter Auto-Fetch
    async function checkUrlParam() {
      const params = new URLSearchParams(window.location.search);
      const url = params.get('dhf') || params.get('url') || params.get('file');
      if (url) {
        showToast('Memuat berkas dari URL parameter...', 'info');
        try {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const buf = await resp.arrayBuffer();
          decodeDHF(buf);
        } catch (e) {
          showToast('Gagal memuat URL: ' + e.message, 'error');
        }
      }
    }

    document.getElementById('btn-fetch-param').addEventListener('click', async () => {
      const url = document.getElementById('input-url-param').value.trim();
      if (!url) return showToast('Masukkan URL berkas .dhf', 'error');
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const buf = await resp.arrayBuffer();
        decodeDHF(buf);
      } catch (e) {
        showToast('Gagal memuat URL: ' + e.message, 'error');
      }
    });

    // Demo Sample
    document.getElementById('btn-load-sample').addEventListener('click', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 640, 400);
      grad.addColorStop(0, '#1e293b'); grad.addColorStop(1, '#0f172a');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 640, 400);
      ctx.fillStyle = '#2563eb'; ctx.beginPath(); ctx.arc(320, 180, 75, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.font = '700 24px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('DHF Converter', 320, 195);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '500 13px Inter, sans-serif';
      ctx.fillText('PT DHAFA TETAP BERUSAHA', 320, 235);
      const imgData = ctx.getImageData(0, 0, 640, 400).data;
      const meta = JSON.stringify({ w: 640, h: 400 });
      const enc = new TextEncoder();
      const mBytes = enc.encode(meta);
      const hdr = enc.encode('DHF!');
      const mLen = new Uint32Array([mBytes.length]);
      const mLenBytes = new Uint8Array(mLen.buffer);
      const raw = new Uint8Array(mBytes.length + imgData.length);
      raw.set(mBytes, 0); raw.set(imgData, mBytes.length);
      const comp = pako.deflate(raw);
      const dhf = new Uint8Array(hdr.length + mLenBytes.length + comp.length);
      dhf.set(hdr, 0); dhf.set(mLenBytes, hdr.length); dhf.set(comp, hdr.length + mLenBytes.length);
      decodeDHF(dhf.buffer);
    });

    checkUrlParam();
  </script>
</body>
</html>`;
}
