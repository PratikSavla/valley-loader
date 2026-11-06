// SPDX-License-Identifier: AGPL-3.0-only
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './views.css';

// Dropping a file on the window would navigate to it (main refuses the navigation too): never even try.
for (const type of ['dragover', 'drop'] as const) {
  document.addEventListener(type, (event) => event.preventDefault());
}

window.addEventListener('unhandledrejection', (event) => {
  console.error('[valley] unhandled promise rejection in renderer', event.reason);
});

const container = document.getElementById('root');
if (!container) throw new Error('Valley Loader: #root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
