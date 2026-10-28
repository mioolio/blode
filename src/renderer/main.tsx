import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from './i18n';
import './web-bridge';
import App from './App';
import './styles.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
