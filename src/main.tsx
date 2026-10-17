import { createRoot } from 'react-dom/client';
import App from './App';
// Bundled so the UI looks the same on every OS, offline.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
