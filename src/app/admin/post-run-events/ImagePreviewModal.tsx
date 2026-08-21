"use client";

import { useEffect, useRef } from "react";

type ImagePreviewModalProps = Readonly<{
  imageUrl: string;
  alt: string;
  onClose: () => void;
}>;

export function ImagePreviewModal({
  imageUrl,
  alt,
  onClose,
}: ImagePreviewModalProps) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/90 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Payment receipt"
      onClick={onClose}
    >
      <button
        type="button"
        autoFocus
        aria-label="Close receipt"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/30 bg-black/80 text-xl font-black text-white outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        ×
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[calc(100svh-2rem)] max-w-full object-contain"
      />
    </div>
  );
}
