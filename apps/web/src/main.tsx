import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Ocean } from './Ocean.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Ocean />
    <App />
  </StrictMode>,
);
