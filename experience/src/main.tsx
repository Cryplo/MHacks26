import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readRuntimeSettings } from './runtime/config';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);
try {
  const settings = readRuntimeSettings(import.meta.env);
  root.render(<StrictMode><App settings={settings} /></StrictMode>);
} catch (e) {
  root.render(
    <main><div className="panel" role="alert" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h1>Configuration error</h1><p>{e instanceof Error ? e.message : String(e)}</p>
    </div></main>,
  );
}
