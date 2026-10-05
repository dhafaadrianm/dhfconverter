import React, { useState, useEffect, useCallback } from 'react';
import {
  FileImage,
  UploadCloud,
  Download,
  AlertTriangle,
  CheckCircle2,
  X,
  ArrowRight,
  Sparkles,
  Code2,
  Copy,
  Check
} from 'lucide-react';
import {
  decodeDHF,
  encodeToDHF,
  createDemoDHF,
  generateStandaloneHtml,
  MagicBytesError,
  DHF_CORE_API_CODE,
  type DecodeResult,
  type EncodeResult
} from './dhfEngine';

interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

interface MagicErrorDetails {
  title: string;
  message: string;
  magicFound: string;
  detectedType?: string;
  rawFile?: File;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export default function App() {
  // Loading
  const [isLoading, setIsLoading] = useState<boolean>(false);

  // API Integration Modal
  const [isApiModalOpen, setIsApiModalOpen] = useState<boolean>(false);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Error Pop-up Modal for Renamed / Invalid Files
  const [errorModal, setErrorModal] = useState<MagicErrorDetails | null>(null);

  // Encoder State
  const [encoderResult, setEncoderResult] = useState<EncodeResult | null>(null);
  const [isEncoderDragOver, setIsEncoderDragOver] = useState<boolean>(false);

  // Decoder State
  const [decoderResult, setDecoderResult] = useState<DecodeResult | null>(null);
  const [isDecoderDragOver, setIsDecoderDragOver] = useState<boolean>(false);

  // -------------------------------------------------------------
  // Encoder Handler
  // -------------------------------------------------------------
  const processImageForEncoding = useCallback(async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      addToast('Berkas bukan gambar yang valid (pilih PNG atau JPG).', 'error');
      return;
    }

    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const dataUrl = e.target?.result as string;
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('Gagal memuat format citra'));
          img.src = dataUrl;
        });

        const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || 'citra';
        const result = await encodeToDHF(img, `${baseName}.dhf`, {
          originalName: file.name,
          company: 'PT DHAFA TETAP BERUSAHA',
        });

        setEncoderResult(result);
        addToast(`Berkas ${result.filename} siap diunduh!`, 'success');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addToast(`Gagal mengonversi: ${msg}`, 'error');
      } finally {
        setIsLoading(false);
      }
    };
    reader.onerror = () => {
      setIsLoading(false);
      addToast('Gagal membaca berkas gambar.', 'error');
    };
    reader.readAsDataURL(file);
  }, [addToast]);

  const handleDownloadDHF = () => {
    if (!encoderResult) return;
    const url = URL.createObjectURL(encoderResult.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = encoderResult.filename;
    a.click();
    URL.revokeObjectURL(url);
    addToast(`Unduhan ${encoderResult.filename} dimulai!`, 'success');
  };

  // -------------------------------------------------------------
  // Decoder Handler with Magic Bytes & Rename Detection
  // -------------------------------------------------------------
  const handleDecodeBuffer = useCallback(
    async (
      buffer: ArrayBuffer | ArrayBufferView | SharedArrayBuffer,
      rawFile?: File,
      sourceLabel = 'berkas.dhf'
    ) => {
      setIsLoading(true);
      try {
        const result = await decodeDHF(buffer, rawFile);
        setDecoderResult(result);
        addToast(`Citra .DHF berhasil dibuka (${result.meta.w} × ${result.meta.h} px)`, 'success');
      } catch (err: unknown) {
        if (err instanceof MagicBytesError) {
          const hexPreview = err.magicFound
            ? Array.from(new TextEncoder().encode(err.magicFound))
                .map((b) => '0x' + b.toString(16).padStart(2, '0').toUpperCase())
                .join(' ')
            : 'Tidak Dikenal';

          if (err.detectedType && err.detectedType !== 'UNKNOWN') {
            setErrorModal({
              title: 'Format Tidak Valid: Ganti Nama Manual Terdeteksi',
              message: `Sistem mendeteksi bahwa berkas "${rawFile ? rawFile.name : sourceLabel}" sebenarnya merupakan gambar ${err.detectedType} asli yang diubah namanya (rename) secara manual menjadi .dhf. Format .DHF memerlukan struktur enkapsulasi biner resmi dengan penanda "DHF!". Silakan gunakan kotak Encoder di atas terlebih dahulu untuk mendapatkan struktur file .DHF yang sah.`,
              magicFound: `${hexPreview} (${err.detectedType})`,
              detectedType: err.detectedType,
              rawFile: rawFile,
            });
          } else {
            setErrorModal({
              title: 'Kegagalan Magic Bytes: Bukan Format .DHF',
              message: `Header biner berkas tidak memuat penanda wajib "DHF!". Berkas ini bukan berkas .DHF yang valid. Silakan gunakan kotak Encoder terlebih dahulu untuk mengubah foto Anda ke format .DHF yang sah.`,
              magicFound: hexPreview,
              detectedType: 'UNKNOWN',
              rawFile: rawFile,
            });
          }
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          addToast(`Gagal mendekode: ${msg}`, 'error');
        }
      } finally {
        setIsLoading(false);
      }
    },
    [addToast]
  );

  const handleDhfFileSelect = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result instanceof ArrayBuffer) {
          handleDecodeBuffer(e.target.result, file, file.name);
        }
      };
      reader.onerror = () => {
        addToast('Gagal membaca berkas dari perangkat.', 'error');
      };
      reader.readAsArrayBuffer(file);
    },
    [addToast, handleDecodeBuffer]
  );

  // URL Remote Fetch
  const handleFetchUrl = useCallback(
    async (targetUrl: string) => {
      if (!targetUrl.trim()) return;
      setIsLoading(true);
      try {
        const res = await fetch(targetUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        const filename = targetUrl.split('/').pop() || 'remote.dhf';
        await handleDecodeBuffer(buffer, undefined, filename);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addToast(`Gagal memuat URL: ${msg}`, 'error');
      } finally {
        setIsLoading(false);
      }
    },
    [addToast, handleDecodeBuffer]
  );

  // URL Parameter Detection on Initial Load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const dhfParam = params.get('dhf') || params.get('url') || params.get('file');
    if (dhfParam) {
      handleFetchUrl(dhfParam);
    }
  }, [handleFetchUrl]);

  // Load Demo Sample
  const handleLoadSample = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/sample.dhf');
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        await handleDecodeBuffer(buffer, undefined, 'sample.dhf');
      } else {
        const demo = await createDemoDHF('Sample.dhf');
        const buffer = demo.dhfBytes.buffer.slice(
          demo.dhfBytes.byteOffset,
          demo.dhfBytes.byteOffset + demo.dhfBytes.byteLength
        );
        await handleDecodeBuffer(buffer, undefined, 'Sample.dhf');
      }
    } catch {
      const demo = await createDemoDHF('Sample.dhf');
      const buffer = demo.dhfBytes.buffer.slice(
        demo.dhfBytes.byteOffset,
        demo.dhfBytes.byteOffset + demo.dhfBytes.byteLength
      );
      await handleDecodeBuffer(buffer, undefined, 'Sample.dhf');
    } finally {
      setIsLoading(false);
    }
  }, [handleDecodeBuffer]);

  // Copy API Code
  const handleCopyApiCode = async () => {
    try {
      await navigator.clipboard.writeText(DHF_CORE_API_CODE);
      setIsCopied(true);
      addToast('Kode pustaka dhf-core-api.js berhasil disalin ke papan klip!', 'success');
      setTimeout(() => setIsCopied(false), 2500);
    } catch {
      addToast('Gagal menyalin kode ke papan klip.', 'error');
    }
  };

  // Download Decoded Preview as PNG, JPG, or WEBP
  const handleDownloadDecodedImage = (format: 'png' | 'jpg' | 'webp') => {
    if (!decoderResult) return;
    const mimeType = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const ext = format === 'jpg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
    const quality = format === 'png' ? undefined : 0.95;
    const dataUrl = decoderResult.canvas.toDataURL(mimeType, quality);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `hasil_foto_dhf.${ext}`;
    a.click();
    addToast(`Citra berhasil diunduh sebagai ${format.toUpperCase()}!`, 'success');
  };

  return (
    <div className="bg-[#f5f5f7] text-[#1d1d1f] min-h-screen flex flex-col justify-between p-4 md:p-8 selection:bg-blue-600 selection:text-white">
      
      {/* Top Hairline Loading Bar */}
      {isLoading && (
        <div className="fixed top-0 left-0 right-0 h-0.5 bg-blue-600 z-50 animate-pulse" />
      )}

      {/* Top Navigation */}
      <nav className="w-full max-w-5xl mx-auto flex justify-between items-center border-b border-gray-200 pb-4 mb-10">
        <div className="flex items-center gap-3">
          <span className="text-xl font-extrabold tracking-tight">
            DHF <span className="text-blue-600">Converter</span>
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          {/* TOMBOL MENU INTEGRASI API */}
          <button
            onClick={() => setIsApiModalOpen(true)}
            className="text-xs font-semibold text-gray-700 hover:text-blue-600 bg-white hover:bg-gray-50 border border-gray-200 hover:border-blue-300 px-3 py-1.5 rounded-lg transition-colors shadow-2xs flex items-center gap-1.5 cursor-pointer"
            title="Buka Dokumentasi Integrasi API DHF"
          >
            <Code2 className="w-3.5 h-3.5 text-blue-600" />
            <span>Integrasi API</span>
          </button>

          <button
            onClick={handleLoadSample}
            className="text-xs font-semibold text-gray-600 hover:text-blue-600 bg-white border border-gray-200 hover:border-blue-300 px-3 py-1.5 rounded-lg transition-colors shadow-2xs flex items-center gap-1.5 cursor-pointer"
            title="Muat sampel citra DHF"
          >
            <Sparkles className="w-3.5 h-3.5 text-blue-600" />
            <span>Coba Sampel</span>
          </button>
          <span className="text-xs font-semibold text-gray-500 bg-white border border-gray-200 px-3 py-1 rounded-full shadow-xs">
            v1.4.0
          </span>
        </div>
      </nav>

      {/* Main Container */}
      <main className="w-full max-w-5xl mx-auto my-auto py-6 grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
        
        {/* Left Side: Title & Description */}
        <div className="space-y-4 pr-0 md:pr-6">
          <div className="inline-flex items-center bg-blue-50 border border-blue-200 text-blue-600 text-[11px] px-3 py-0.5 rounded-full font-bold uppercase tracking-wider">
            Next-Gen Custom Format
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight leading-tight text-gray-900">
            DHF Converter
          </h1>
          <p className="text-gray-500 text-sm md:text-base leading-relaxed">
            DHF adalah format yang memungkinkan anda menjaga privasi foto anda.
          </p>
        </div>

        {/* Right Side: Interface Cards */}
        <div className="space-y-6">
          
          {/* KOTAK ENCODER: JPG/PNG ke .DHF */}
          <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-xs transition-all duration-300 hover:shadow-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-800">Ubah JPG / PNG ke .DHF</h2>
              <span className="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md border border-gray-100 font-medium">
                Encoder
              </span>
            </div>
            
            <label
              htmlFor="upload-biasa"
              onDragOver={(e) => { e.preventDefault(); setIsEncoderDragOver(true); }}
              onDragLeave={() => setIsEncoderDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsEncoderDragOver(false);
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                  processImageForEncoding(e.dataTransfer.files[0]);
                }
              }}
              className={`flex flex-col items-center justify-center border border-dashed rounded-xl py-8 px-4 cursor-pointer transition-all duration-200 group ${
                isEncoderDragOver
                  ? 'border-blue-500 bg-blue-50/50'
                  : 'bg-gray-50 hover:bg-gray-100/70 border-gray-200'
              }`}
            >
              <span className="text-xs font-semibold text-gray-600 group-hover:text-blue-600 transition-colors">
                Pilih atau Seret Foto Anda
              </span>
              <span className="text-[10px] text-gray-400 mt-1">
                Mendukung file PNG atau JPG
              </span>
              <input
                type="file"
                id="upload-biasa"
                accept="image/png,image/jpeg,image/webp,image/bmp"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    processImageForEncoding(e.target.files[0]);
                  }
                }}
                className="hidden"
              />
            </label>

            {encoderResult && (
              <div id="action-encoder" className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-gray-500 px-1 font-mono">
                  <span className="truncate max-w-[190px]">{encoderResult.filename}</span>
                  <span className="text-emerald-600 font-semibold">{encoderResult.ratio}% Lebih Hemat</span>
                </div>
                <button
                  id="btn-convert-dhf"
                  onClick={handleDownloadDHF}
                  className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2.5 px-4 rounded-xl text-xs transition-colors shadow-xs cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  <span>Unduh Berkas .DHF</span>
                </button>
              </div>
            )}
          </div>

          {/* KOTAK DECODER: .DHF ke Foto Asli */}
          <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-xs transition-all duration-300 hover:shadow-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-gray-800">Buka File .DHF ke Gambar Asli</h2>
              <span className="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-md border border-gray-100 font-medium">
                Decoder
              </span>
            </div>

            <label
              htmlFor="upload-dhf"
              onDragOver={(e) => { e.preventDefault(); setIsDecoderDragOver(true); }}
              onDragLeave={() => setIsDecoderDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDecoderDragOver(false);
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                  handleDhfFileSelect(e.dataTransfer.files[0]);
                }
              }}
              className={`flex flex-col items-center justify-center border border-dashed rounded-xl py-8 px-4 cursor-pointer transition-all duration-200 group ${
                isDecoderDragOver
                  ? 'border-blue-500 bg-blue-50/50'
                  : 'bg-gray-50 hover:bg-gray-100/70 border-gray-200'
              }`}
            >
              <span className="text-xs font-semibold text-gray-600 group-hover:text-blue-600 transition-colors">
                Pilih Berkas .DHF
              </span>
              <span className="text-[10px] text-gray-400 mt-1">
                Hanya memproses format khusus .dhf
              </span>
              <input
                type="file"
                id="upload-dhf"
                accept=".dhf"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleDhfFileSelect(e.target.files[0]);
                  }
                }}
                className="hidden"
              />
            </label>

            {/* Preview Area */}
            {decoderResult && (
              <div id="preview-container" className="mt-4 border border-gray-100 bg-gray-50 rounded-xl p-3 flex flex-col items-center space-y-2">
                <div className="flex items-center justify-between w-full">
                  <span className="text-[10px] text-blue-600 font-bold uppercase tracking-wider">
                    Hasil Pratinjau Foto:
                  </span>
                  <span className="text-[11px] font-mono text-gray-500 tabular-nums">
                    {decoderResult.meta.w} × {decoderResult.meta.h} px · {formatBytes(decoderResult.fileBytes)}
                  </span>
                </div>
                
                <img
                  id="hasil-foto"
                  src={decoderResult.dataUrl}
                  className="w-full h-auto rounded-lg max-h-48 object-contain bg-white border border-gray-200"
                  alt="Hasil Pratinjau DHF"
                />

                {/* AREA BUTTON PILIHAN UNDUHAN: PNG, JPG, WEBP */}
                <div id="download-options" className="w-full grid grid-cols-3 gap-2 pt-2">
                  <button
                    onClick={() => handleDownloadDecodedImage('png')}
                    className="bg-gray-900 hover:bg-black text-white text-xs font-semibold py-2 px-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Unduh PNG</span>
                  </button>
                  <button
                    onClick={() => handleDownloadDecodedImage('jpg')}
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2 px-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Unduh JPG</span>
                  </button>
                  <button
                    onClick={() => handleDownloadDecodedImage('webp')}
                    className="bg-white hover:bg-gray-100 border border-gray-200 text-gray-800 text-xs font-semibold py-2 px-2.5 rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-2xs"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Unduh WEBP</span>
                  </button>
                </div>
              </div>
            )}
          </div>

        </div>
      </main>

      {/* Footer */}
      <footer className="w-full max-w-5xl mx-auto border-t border-gray-200 pt-6 mt-12 text-[11px] text-gray-400 flex flex-col md:flex-row justify-between gap-4 items-start md:items-center">
        <div className="max-w-xl">
          &copy; 2026 dhf adalah format privasi yang dikembangkan oleh DHAFA ADRIAN MAULANA dengan tujuan menjaga privasi foto anda. Hak cipta dilindungi oleh undang - undang
        </div>
        <div className="font-bold text-gray-500 whitespace-nowrap">
          Dikembangkan oleh PT DHAFA TETAP BERUSAHA
        </div>
      </footer>

      {/* JENDELA POP-UP (MODAL BOX) INTEGRASI API DENGAN EFEK GLASSMORPHISM */}
      {isApiModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white/95 backdrop-blur-xl border border-white/60 shadow-2xl rounded-2xl max-w-2xl w-full p-6 max-h-[90vh] flex flex-col space-y-4">
            
            {/* Header Modal */}
            <div className="flex items-start justify-between pb-3 border-b border-gray-100">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 shrink-0">
                  <Code2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-900 leading-snug">
                    Dokumentasi Resmi: <span className="font-mono text-blue-600">dhf-core-api.js</span>
                  </h3>
                  <p className="text-xs text-gray-500">
                    Pustaka integrasi JavaScript untuk pemrosesan format citra privasi .DHF di aplikasi pihak ketiga.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsApiModalOpen(false)}
                className="text-gray-400 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 p-1.5 rounded-lg transition-colors cursor-pointer"
                title="Tutup Modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Quick Guide & Prerequisites */}
            <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-3 text-xs text-blue-900 space-y-1">
              <div className="font-semibold flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                <span>Petunjuk Integrasi Pengembang</span>
              </div>
              <p className="text-[11px] text-blue-700 leading-relaxed">
                Pustaka ini memerlukan dependensi <strong>pako</strong> (zlib compression). Sisipkan script pako via CDN sebelum memanggil fungsi <code className="font-mono bg-blue-100/70 px-1 py-0.5 rounded">encodeToDHF()</code> atau <code className="font-mono bg-blue-100/70 px-1 py-0.5 rounded">decodeDHF()</code>.
              </p>
            </div>

            {/* Code Box with Copy Button */}
            <div className="relative flex-1 min-h-0 bg-[#0f172a] rounded-xl border border-gray-800 overflow-hidden flex flex-col shadow-inner">
              <div className="flex items-center justify-between px-3.5 py-2 bg-slate-900 border-b border-slate-800">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                  <span className="text-[11px] font-mono text-gray-400 ml-1">dhf-core-api.js</span>
                </div>
                <button
                  onClick={handleCopyApiCode}
                  className="bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-semibold py-1 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-2xs cursor-pointer"
                >
                  {isCopied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-300" />
                      <span>Tersalin!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Salin Kode</span>
                    </>
                  )}
                </button>
              </div>

              <pre className="p-4 text-[11px] font-mono text-slate-200 overflow-y-auto max-h-[300px] leading-relaxed selection:bg-blue-500 selection:text-white">
                <code>{DHF_CORE_API_CODE}</code>
              </pre>
            </div>

            {/* Footer Modal Action */}
            <div className="flex items-center justify-between pt-2 border-t border-gray-100 text-xs">
              <span className="text-[11px] text-gray-400">
                Lisensi Privasi & Hak Cipta dilindungi undang - undang.
              </span>
              <button
                onClick={() => setIsApiModalOpen(false)}
                className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl transition-colors cursor-pointer"
              >
                Selesai
              </button>
            </div>

          </div>
        </div>
      )}

      {/* AESTHETIC ERROR POP-UP MODAL: MAGIC BYTES MISMATCH / MANUAL RENAME DETECTED */}
      {errorModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-gray-100 space-y-4 transform transition-all">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="space-y-1 flex-1">
                <h3 className="text-sm font-bold text-gray-900 leading-snug">
                  {errorModal.title}
                </h3>
                <p className="text-xs text-gray-500 leading-relaxed">
                  {errorModal.message}
                </p>
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-3.5 border border-gray-100 text-[11px] text-gray-600 space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Header Ditemukan:</span>
                <span className="font-mono font-semibold text-red-600">
                  {errorModal.magicFound}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400">Header Wajib:</span>
                <span className="font-mono font-semibold text-blue-600">
                  DHF! (0x44 0x48 0x46 0x21)
                </span>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              {errorModal.rawFile && (
                <button
                  onClick={() => {
                    const f = errorModal.rawFile;
                    setErrorModal(null);
                    if (f) processImageForEncoding(f);
                  }}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold py-2.5 rounded-xl transition-colors shadow-xs cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <span>Konversi via Encoder Sekarang</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setErrorModal(null)}
                className="px-4 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold py-2.5 rounded-xl transition-colors cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FLOATING TOASTS */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-2xl shadow-xl text-xs font-medium transition-all duration-300 transform translate-y-0 ${
              toast.type === 'error'
                ? 'bg-red-600 text-white shadow-red-600/20'
                : toast.type === 'success'
                ? 'bg-gray-900 text-white shadow-gray-900/20'
                : 'bg-white text-gray-900 border border-gray-200 shadow-gray-500/10'
            }`}
          >
            {toast.type === 'error' && <AlertTriangle className="w-4 h-4 shrink-0 text-white mt-0.5" />}
            {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />}
            <span className="flex-1 leading-relaxed">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="text-gray-400 hover:text-white shrink-0 p-0.5 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

    </div>
  );
}
