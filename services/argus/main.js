// Argus process entry point. PM2 (fork mode) loads scripts from its own
// container, so process.argv[1] is never this file — an "is main module" guard
// silently never starts the server. This file always starts; argus.js stays a
// side-effect-free library (tests import createApp/start from it).
import { start } from './argus.js';

start();
