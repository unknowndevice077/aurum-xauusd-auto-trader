import AurumTerminal from '../components/AurumTerminal';
import AlwaysOnBot from '../components/AlwaysOnBot';

export default function Home() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      <AlwaysOnBot />
      <div style={{ height: '32px' }} />
      <AurumTerminal />
    </main>
  );
}
