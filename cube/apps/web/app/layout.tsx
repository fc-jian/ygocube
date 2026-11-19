import type { Metadata, Viewport } from 'next';
import './globals.css';
import { CardPreviewHost } from '@/components/CardPreview';
import { FontSizeController } from '@/components/FontSizeController';

export const metadata: Metadata = {
  title: { default: 'YGO Cube', template: '%s · YGO Cube' },
  description: 'Cube draft tournament system for YGOPro',
  applicationName: 'YGO Cube',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">
        {children}
        <CardPreviewHost />
        <FontSizeController />
      </body>
    </html>
  );
}
