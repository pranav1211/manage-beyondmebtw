// Manage API process entry point. Always starts (see services/argus/main.js
// for why an argv-based "is main module" guard fails under PM2).
import { start } from './index.js';

start();
