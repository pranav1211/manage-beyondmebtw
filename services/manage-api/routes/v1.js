// Versioned API router scaffold (/api/v1).
// Stage 1: route surface only. Handlers return NOT_IMPLEMENTED so the contract
// is visible and testable without wiring canonical data or Argus yet.

import express from 'express';
import { ERROR_CODES } from '../../../shared/errors.js';

export function createV1Router() {
  const router = express.Router();

  const notImplemented = (name) => (_req, res) => {
    res.status(501).json({
      code: ERROR_CODES.NOT_IMPLEMENTED,
      message: `Not implemented in Stage 1: ${name}`
    });
  };

  // ── Auth (server-validated session — replaces legacy shared-key cookie) ──
  router.post('/auth/login', notImplemented('POST /auth/login'));
  router.post('/auth/logout', notImplemented('POST /auth/logout'));
  router.get('/auth/session', notImplemented('GET /auth/session'));

  // ── Domain-facing reads (served from canonical store, Stage 6) ──
  router.get('/home', notImplemented('GET /home'));
  router.get('/blog/categories', notImplemented('GET /blog/categories'));
  router.get('/blog/:category', notImplemented('GET /blog/:category'));
  router.get('/projects', notImplemented('GET /projects'));
  router.get('/photos', notImplemented('GET /photos'));

  // ── Minis content (Manage owns canonical Markdown; Minis backend is editor) ──
  router.get('/minis/posts', notImplemented('GET /minis/posts'));
  router.get('/minis/posts/:id', notImplemented('GET /minis/posts/:id'));
  router.post('/minis/posts', notImplemented('POST /minis/posts'));
  router.put('/minis/posts/:id', notImplemented('PUT /minis/posts/:id'));
  router.delete('/minis/posts/:id', notImplemented('DELETE /minis/posts/:id'));

  // ── Catalog-backed generic resource management (admin, Stage 6) ──
  router.get('/data/resources', notImplemented('GET /data/resources'));
  router.get('/data/resources/:key', notImplemented('GET /data/resources/:key'));
  router.post('/data/resources', notImplemented('POST /data/resources'));
  router.put('/data/resources/:key', notImplemented('PUT /data/resources/:key'));
  router.delete('/data/resources/:key', notImplemented('DELETE /data/resources/:key'));

  // ── Application registry + Argus operation requests (admin, Stage 5) ──
  router.get('/registry', notImplemented('GET /registry'));
  router.post('/registry', notImplemented('POST /registry'));
  router.get('/registry/:application', notImplemented('GET /registry/:application'));
  router.post('/operations', notImplemented('POST /operations'));
  router.get('/operations/:operationId', notImplemented('GET /operations/:operationId'));

  return router;
}
