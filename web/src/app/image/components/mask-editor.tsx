"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { X } from "lucide-react";

type Props = {
  imageUrl: string;
  onConfirm: (imageDataUrl: string, maskDataUrl: string) => void;
  onCancel: () => void;
};

export function MaskEditor({ imageUrl, onConfirm, onCancel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [brushSize, setBrushSize] = useState(30);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const container = containerRef.current;
      if (!container) return;
      const maxW = container.clientWidth - 32;
      const maxH = window.innerHeight * 0.6;
      let w = img.width;
      let h = img.height;
      if (w > maxW) { h = h * (maxW / w); w = maxW; }
      if (h > maxH) { w = w * (maxH / h); h = maxH; }
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      setImgLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const getPos = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const draw = useCallback((x: number, y: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    setHasMask(true);
  }, [brushSize]);

  const handleStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    setIsDrawing(true);
    const pos = getPos(e);
    draw(pos.x, pos.y);
  }, [getPos, draw]);

  const handleMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return;
    e.preventDefault();
    const pos = getPos(e);
    draw(pos.x, pos.y);
  }, [isDrawing, getPos, draw]);

  const handleEnd = useCallback(() => setIsDrawing(false), []);

  const handleConfirm = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Create transparent image (masked area becomes transparent)
    const imageDataUrl = canvas.toDataURL("image/png");

    // Create mask: white = edit area (where user painted), black = keep area
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const mCtx = maskCanvas.getContext("2d");
    if (!mCtx) return;

    // Draw original image as white background
    mCtx.fillStyle = "black";
    mCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

    // Draw the erased areas as white
    mCtx.drawImage(canvas, 0, 0);

    const maskDataUrl = maskCanvas.toDataURL("image/png");
    onConfirm(imageDataUrl, maskDataUrl);
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setHasMask(false);
    };
    img.src = imageUrl;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div ref={containerRef} className="relative max-h-[90vh] w-[95vw] max-w-[800px] rounded-2xl bg-white p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-stone-900">遮罩编辑 — 涂抹要编辑的区域</h3>
          <button type="button" onClick={onCancel} className="rounded-full p-1 hover:bg-stone-100">
            <X className="size-4 text-stone-500" />
          </button>
        </div>

        <p className="mb-2 text-xs text-stone-500">
          用画笔涂抹你希望 AI 重新绘制的区域（涂抹部分会被擦除），然后点击"确认遮罩"
        </p>

        <div className="mb-3 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-500">画笔大小</span>
            <input
              type="range"
              min="5"
              max="80"
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="w-24 accent-stone-900"
            />
            <span className="text-xs text-stone-400">{brushSize}px</span>
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-full border border-stone-200 px-3 py-1 text-xs font-medium text-stone-600 hover:bg-stone-50"
          >
            清除遮罩
          </button>
        </div>

        <div className="mb-3 flex justify-center overflow-hidden rounded-xl border border-stone-200 bg-[conic-gradient(#e5e7eb_25%,#f3f4f6_25%,#f3f4f6_50%,#e5e7eb_50%,#e5e7eb_75%,#f3f4f6_75%)] bg-[length:16px_16px]">
          <canvas
            ref={canvasRef}
            className="cursor-crosshair"
            style={{ touchAction: "none" }}
            onMouseDown={handleStart}
            onMouseMove={handleMove}
            onMouseUp={handleEnd}
            onMouseLeave={handleEnd}
            onTouchStart={handleStart}
            onTouchMove={handleMove}
            onTouchEnd={handleEnd}
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-stone-200 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!hasMask || !imgLoaded}
            className="rounded-xl bg-stone-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            确认遮罩
          </button>
        </div>
      </div>
    </div>
  );
}
