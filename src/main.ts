import { mountPanel } from './ui/panel';

const root = document.getElementById('app');
if (!root) {
  throw new Error('main.ts: #app root element not found');
}
mountPanel(root);
