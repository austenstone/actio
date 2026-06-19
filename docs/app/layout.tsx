import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import { appDescription, appName, siteUrl } from '@/lib/shared';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

const siteTitle = `${appName} · GitHub Actions YAML transpiler`;
const ogImage = `${siteUrl}/og/docs/image.png`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: `%s · ${appName}`,
  },
  description: appDescription,
  applicationName: appName,
  alternates: {
    canonical: `${siteUrl}/`,
  },
  openGraph: {
    type: 'website',
    siteName: appName,
    title: siteTitle,
    description: appDescription,
    url: `${siteUrl}/`,
    locale: 'en_US',
    images: ogImage,
  },
  twitter: {
    card: 'summary_large_image',
    title: siteTitle,
    description: appDescription,
    images: ogImage,
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
