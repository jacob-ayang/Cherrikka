import '@fontsource/silkscreen';
import './ui/theme.css';
import { mountApp } from './ui/app';

const app = document.querySelector<HTMLElement>('#app');
if (!app) {
  throw new Error('#app not found');
}

mountApp(app);
