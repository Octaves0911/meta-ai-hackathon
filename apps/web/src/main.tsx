import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/components.css';
import './styles/app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
