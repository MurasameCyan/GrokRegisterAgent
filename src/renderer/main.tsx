import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './theme/ThemeProvider';
import { installWebApiIfNeeded } from './lib/webApi';
import './styles/globals.css';

// 浏览器（非 Electron）模式下，给 window.api 装上 HTTP/WebSocket 适配层
installWebApiIfNeeded();

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
