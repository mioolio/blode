import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n';
import './web-bridge';
import App from './App';
import './styles.css';

function RendererReady() {
  React.useEffect(() => {
    // A one-shot signal lets the native window display the first committed shell,
    // independently of background device/toolchain checks and editor startup.
    window.blode.rendererReady?.();
  }, []);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
      <RendererReady />
    </I18nProvider>
  </React.StrictMode>,
);
