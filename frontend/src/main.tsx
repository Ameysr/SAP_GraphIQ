import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Auto-reload once on first visit to fix chart rendering issues
if (!sessionStorage.getItem('reloaded')) {
  sessionStorage.setItem('reloaded', 'true');
  window.location.reload();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
