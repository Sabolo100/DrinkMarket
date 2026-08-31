import type { Metadata, Viewport } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: 'RADOVIN Ár-intelligencia',
    template: '%s · RADOVIN Ár-intelligencia',
  },
  description:
    'Webshopközi italár-figyelő és termékazonosító rendszer. Bizonyítékalapú termékpárosítás, ' +
    'árösszehasonlítás és forrásfelügyelet magyar bor- és töményital-webshopokra.',
  robots: { index: false, follow: false },
  applicationName: 'RADOVIN Ár-intelligencia',
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F6F2EA' },
    { media: '(prefers-color-scheme: dark)', color: '#171012' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hu" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
