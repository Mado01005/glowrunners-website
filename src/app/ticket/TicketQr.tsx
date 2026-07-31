"use client";

import { QRCodeSVG } from "qrcode.react";

type TicketQrProps = {
  value: string;
};

export function TicketQr({ value }: TicketQrProps) {
  return (
    <QRCodeSVG
      value={value}
      size={276}
      className="block h-auto w-full max-w-full"
      bgColor="#ffffff"
      fgColor="#121212"
      level="H"
      marginSize={2}
      role="img"
      aria-label="GlowRunners check-in QR code"
      title="GlowRunners check-in QR code"
    />
  );
}
