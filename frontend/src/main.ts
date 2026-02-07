import './ui/theme.css';
import { mountApp } from './ui/app';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('missing #app root');
}

mountApp(root);
