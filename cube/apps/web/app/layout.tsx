import type { Metadata } from 'next';
import './globals.css';
import { CardPreviewHost } from '@/components/CardPreview';
import { FontSizeController } from '@/components/FontSizeController';

export const metadata: Metadata = {
  title: 'YGO Cube',
  description: 'Cube draft tournament system for YGOPro',
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
