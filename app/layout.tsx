import './globals.css';

export const metadata = {
  title: 'Aurum — XAU/USD Paper Trading Terminal',
  description: 'Simulated gold paper-trading terminal with LLM news sentiment.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0E0F10' }}>{children}</body>
    </html>
  );
}
